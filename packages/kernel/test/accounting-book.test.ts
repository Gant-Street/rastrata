import { describe, expect, test } from "bun:test";
import {
  ExactRational,
  ExactDecimal,
  dimensionMemberId,
  accountId,
  accountingPolicyCapabilityIsExecutable as productionPolicyIsExecutable,
  allocationRecognitionId,
  allocationScheduleId,
  allocationScheduleRevisionId,
  commandId,
  createCanonicalPostingReference,
  canonicalPostingReferenceId,
  commandInputHash,
  commitBookIntent,
  consolidationCompilationId,
  createBookProtocolState,
  createAccountingPolicySnapshot,
  createAccountingReadSnapshot,
  createBookState as createKernelBookState,
  decodeDurableBook,
  encodeDurableBook,
  evaluateBookCommand,
  executeBookCommand,
  evaluateCurrentBookCommand,
  canonicalPostingSourceIdentity,
  accountingEffectExists,
  requiresRemeasurementReversal,
  type CurrentBookContext,
  type BookProtocolState,
  hashCanonical,
  hashAccountingReadSnapshot,
  hashBookState,
  instant,
  inventoryRecostingId,
  inventoryValueAdjustmentId,
  inventoryDisposalSelectionMatches,
  resolveRecostingPeriod,
  journalId,
  lotAllocationId,
  lotHoldingId,
  lotId,
  localDate,
  openItemId,
  projectAccountingBasis,
  postingId,
  provisionalInventoryLayerId,
  remeasurementResultId,
  remeasurementReversalId,
  sealCommand,
  semanticVersion,
  settlementAllocationId,
  settlementId,
  taxDeterminationId,
  resolveJournal,
  validateBookState,
  validateBookEffectTopology,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  type AccountingPolicy,
  type AccountingBasisPolicy,
  type AllocationPolicy,
  type AtomicBookCommit,
  type BookCommand,
  type BookState,
  type ResolvedTransaction,
  type ConsolidationPolicy,
  type CurrencyPolicy,
  type InventoryCostPolicy,
  type InventoryValueAdjustmentPolicy,
  type MonetaryClassificationPolicy,
  type QuantizationPolicy,
  type TaxPolicy,
  type TaxRoundingLevel,
} from "../src/index.ts";
import { IDS, identity, journal, periods, policy, postingReference, quantizationPolicy, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";
import { basisRule, capability, classificationRule, consolidationMapping, consolidationValuationPolicy, pool, taxComponent, translationRule } from "./accounting-fixtures.ts";
import { derivationId, dimensionId, effectKey, evidenceId, identifier, policyId, quantizationPolicyId } from "../src/index.ts";

const one = ExactRational.of(1n, 1n);
const acct = (value: string) => accountId(`account-${value}`);
const A = Object.freeze({ inventory: acct("inventory"), cost: acct("cost"), adjustment: acct("adjustment"), ar: acct("ar"), gain: acct("gain"), loss: acct("loss"), allocation: acct("allocation"), contra: acct("contra"), inputTax: acct("input-tax"), ap: acct("ap"), elimination: acct("elimination"), target: acct("target"), translation: acct("translation"), nci: acct("nci"), equity: acct("equity") });
const evidence = Object.freeze({ id: evidenceId("book-accounting-evidence"), sourceSystem: "test", sourceRecordId: "book", observedAt: instant("2026-01-01T00:00:00Z"), contentHash: hashCanonical({ evidence: "book-accounting" }) });
const derivation = Object.freeze({ id: derivationId("book-accounting-derivation"), policyId: policy.id, policyVersion: policy.version, algorithmVersion: semanticVersion("1.0.0"), inputHash: hashCanonical({ input: "book-accounting" }), actorId: IDS.actor, state: "approved" as const, recordedAt: instant("2026-01-01T00:00:00Z"), evidence: Object.freeze([evidence]) });
const core = (kind: AccountingPolicy["kind"], id: string, method: string) => ({ id: policyId(id), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability(kind, method) });
const inventoryPolicy: InventoryCostPolicy = Object.freeze({ ...core("inventoryCost", "book-inventory", "fifo"), kind: "inventoryCost", method: "fifo", pools: Object.freeze([pool("book-inventory-pool", "inventory")]), shortageTreatment: "provisionalNegative", provisionalBasisMethod: "explicitRate", provisionalRate: ExactRational.of(7n, 1n) });
const inventoryDerivation = Object.freeze({ ...derivation, policyId: inventoryPolicy.id, policyVersion: inventoryPolicy.version });
const inventoryValuePolicy: InventoryValueAdjustmentPolicy = Object.freeze({
  ...core("inventoryValueAdjustment", "book-inventory-value", "valueAdjustment"),
  kind: "inventoryValueAdjustment",
  inventoryCostPolicyId: inventoryPolicy.id,
  inventoryCostPolicyVersion: inventoryPolicy.version,
  allowedKinds: Object.freeze(["directlyAttributableCost", "purchaseRebate", "productionOverhead", "writeDown", "writeDownReversal"] as const),
  inventoryAccountId: A.inventory,
  recognizedCostAccountId: A.cost,
  adjustmentAccountId: A.adjustment,
});
const currencyPolicy: CurrencyPolicy = Object.freeze({ ...core("currencyRemeasurement", "book-currency", "closingRate"), kind: "currencyRemeasurement", reversalRequired: true, gainAccountId: A.gain, lossAccountId: A.loss });
const monetaryPolicy: MonetaryClassificationPolicy = Object.freeze({ ...core("monetaryClassification", "book-monetary", "accountRule"), kind: "monetaryClassification", rules: Object.freeze([classificationRule("book-monetary-ar", "ar", "monetary")]) });
const basisRules: AccountingBasisPolicy["rules"] = Object.freeze([
  basisRule("book-basis-recognition", "recognition", "carryThrough"), basisRule("book-basis-settlement", "settlement", "carryThrough"),
  basisRule("book-basis-credit", "creditApplication", "carryThrough"), basisRule("book-basis-writeoff", "writeOff", "carryThrough"),
  basisRule("book-basis-tax", "tax", "carryThrough"), basisRule("book-basis-inventory", "inventoryCost", "carryThrough"),
  basisRule("book-basis-noncash", "nonCash", "exclude"), basisRule("book-basis-rounding", "rounding", "carryThrough"),
]);
const basisPolicy: AccountingBasisPolicy = Object.freeze({ ...core("accountingBasis", "book-basis", "cash"), kind: "accountingBasis", basis: "cash", rules: basisRules });
const allocationPolicy: AllocationPolicy = Object.freeze({ ...core("allocationSchedule", "book-allocation", "straightLine"), kind: "allocationSchedule", method: "straightLine", frequency: "monthly", convention: "fullPeriod", allocationAccountId: A.allocation, contraAccountId: A.contra });
const taxPolicy: TaxPolicy = Object.freeze({ ...core("taxDetermination", "book-tax", "compound"), kind: "taxDetermination", taxCode: "GST", jurisdiction: "TEST", roundingLevel: "lineLevel" as const, components: Object.freeze([taxComponent("book-tax-component", { rate: ExactRational.of(1n, 10n), inclusion: "exclusive" as const, treatment: "inputTax" as const, recoverability: "recoverable" as const, recoverableShare: one, compoundOrdinal: 1n, compoundsOn: Object.freeze([]), liabilityAccountId: A.ap, recoverableAccountId: A.inputTax })]) });
const consolidationPolicy: ConsolidationPolicy = Object.freeze({ ...core("consolidation", "book-consolidation", "full"), kind: "consolidation", supportedMethods: Object.freeze(["full"] as const), accountMappings: Object.freeze([consolidationMapping("book-map-target", "target", "target"), consolidationMapping("book-map-inventory", "inventory", "inventory", "source-book"), consolidationMapping("book-map-equity", "equity", "equity", "source-book")]), translationRules: Object.freeze([translationRule("book-translate-target", "target", "target", "source-book"), translationRule("book-translate-inventory", "inventory", "inventory", "source-book")]), valuationPolicy: consolidationValuationPolicy("book-valuation"), translationAdjustmentAccountId: A.translation, parentAttributableEquityAccountId: A.equity, nonControllingInterestAccountId: A.nci });
const accountingPolicies: readonly AccountingPolicy[] = Object.freeze([inventoryPolicy, basisPolicy, monetaryPolicy, currencyPolicy, allocationPolicy, taxPolicy, consolidationPolicy]);
const accountingPolicyCapabilityIsExecutable = (candidate: unknown) => productionPolicyIsExecutable(candidate as AccountingPolicy);

for (const executionProfile of [undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE] as const) {
// Every custom genesis in this capability suite must use the selected profile,
// not just the common fixture. Calls still reach the real production constructor.
function createBookState(...args: Parameters<typeof createKernelBookState>): BookState {
  return createKernelBookState(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7] ?? executionProfile);
}
function stateWithAccounting(extra: readonly AccountingPolicy[] = []): BookState {
  const base = createBookState(identity, periods, {
    bookId: IDS.book, functionalCommodityId: IDS.usd,
    accounts: [IDS.cash, IDS.revenue, ...Object.values(A)].map((id, index) => Object.freeze({ id, bookId: IDS.book, code: `${1000 + index}`, name: id, role: index === 1 ? "income" as const : "asset" as const, normalSide: index === 1 ? "credit" as const : "debit" as const, postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) })),
    dimensions: Object.freeze([]), dimensionMembers: Object.freeze([]), requiredDimensionIds: Object.freeze([]),
    requiredDimensionIdsByPosting: Object.freeze({ "reserved-generated-posting": Object.freeze([]) }),
  }, [policy], [quantizationPolicy], Object.freeze([...accountingPolicies, ...extra]), instant("2020-01-01T00:00:00Z"), executionProfile);
  return base;
}

function times(value = "2026-01-15T14:00:00Z") {
  const ms = Date.parse(value);
  return { issuedAt: instant(value), completedAt: instant(new Date(ms + 1_000).toISOString()), committedAt: instant(new Date(ms + 2_000).toISOString()) };
}

function coreCommand(state: BookState, id: string, at?: string) {
  return { id: commandId(id), protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book, expectedBookRevision: state.bookRevision, ...times(at), actorId: IDS.actor };
}

function run(current: AtomicBookCommit, command: BookCommand): AtomicBookCommit {
  const next = executeBookCommand(current.state, current.protocol, command);
  expect(next.result.disposition, `${command.type}:${next.result.diagnostics[0]?.message ?? ""}`).toBe("committed");
  if (command.type === "compileConsolidation") {
    const context = { ...currencyContext(current.state, current.protocol, command),
      consolidationFacts: { compilationIdentity: (id: string) => current.state.accountingState.consolidationCompilations.some(value => value.id === id) ? "present" as const : "absent" as const },
    };
    const actual = evaluateCurrentBookCommand(context, command);
    expect(actual.result).toEqual(next.result);
    expect(actual.effects).toEqual(next.intent?.effects);
    expect(actual.revision).toEqual(next.state.revisions.at(-1));
    const { consolidationFacts, ...missing } = context;
    expect(() => evaluateCurrentBookCommand(missing, command)).toThrow("Missing current compilation identity evidence");
    expect(() => evaluateCurrentBookCommand({ ...context, consolidationFacts: { compilationIdentity: () => undefined as never } }, command)).toThrow("Incomplete accounting effect identity evidence");
    const invalid = sealCommand({ ...command, request: { ...command.request, sources: command.request.sources.map(source => ({ ...source, expectedRevision: source.revision + 1n })) } });
    const rejected = executeBookCommand(current.state, current.protocol, invalid);
    expect(rejected.result.disposition).toBe("rejected");
    expect(evaluateCurrentBookCommand(context, invalid).result).toEqual(rejected.result);
    expect(evaluateCurrentBookCommand({ ...currencyContext(next.state, next.protocol, command),
      get consolidationFacts(): never { throw new Error("Retry must not read compilation identity"); },
    }, command).result.disposition).toBe("replayed");
    const duplicate = sealCommand({ ...command, ...coreCommand(next.state, `duplicate-${command.id}`, command.issuedAt) });
    const collision = executeBookCommand(next.state, next.protocol, duplicate);
    expect(collision.result.disposition).toBe("rejected");
    expect(evaluateCurrentBookCommand({ ...currencyContext(next.state, next.protocol, duplicate),
      consolidationFacts: { compilationIdentity: id => next.state.accountingState.consolidationCompilations.some(value => value.id === id) ? "present" : "absent" },
    }, duplicate).result).toEqual(collision.result);
  }
  if (command.type === "postCurrencyRemeasurement") {
    const context = currencyContext(current.state, current.protocol, command);
    const actual = evaluateCurrentBookCommand(context, command);
    expect(actual.result).toEqual(next.result);
    expect(actual.effects).toEqual(next.intent?.effects);
    expect(actual.revision).toEqual(next.state.revisions.at(-1));
    const invalid = sealCommand({ ...command, request: { ...command.request,
      ...(command.request.reversalOf === undefined
        ? { generatedEffectKey: effectKey("not-this-command:journal:0") }
        : { reversalOf: remeasurementResultId("not-a-retained-result") }),
    } });
    const rejected = executeBookCommand(current.state, current.protocol, invalid);
    expect(rejected.result.disposition).toBe("rejected");
    expect(evaluateCurrentBookCommand(context, invalid).result).toEqual(rejected.result);
    const { currencyFacts, ...missingCurrency } = context;
    expect(() => evaluateCurrentBookCommand(missingCurrency, command)).toThrow("Missing current currency evidence");
    expect(() => evaluateCurrentBookCommand({ ...context, currencyFacts: { ...context.currencyFacts!, accountingIdentity: () => undefined as never } }, command)).toThrow("Incomplete accounting effect identity evidence");
    if (command.request.reversalOf === undefined) {
      for (const allocatedSource of [() => undefined as never, () => ({ bookValue: ExactRational.of(-1n, 1n), quantity: ExactRational.zero() })])
        expect(() => evaluateCurrentBookCommand({ ...context, currencyFacts: { ...context.currencyFacts!, allocatedSource } }, command)).toThrow("Incomplete allocated monetary source evidence");
      expect(() => evaluateCurrentBookCommand({ ...context, currencyFacts: { ...context.currencyFacts!, sourceRemeasurement: () => undefined as never } }, command)).toThrow("Incomplete source remeasurement evidence");
    }
    const replay = evaluateCurrentBookCommand({ ...currencyContext(next.state, next.protocol, command),
      get currencyFacts(): never { throw new Error("Retry must not read new currency state"); },
    }, command);
    expect(replay.result.disposition).toBe("replayed");
    const original = next.state.journals.find(row => row.commandId === command.id)!;
    const correctionId = `generic-${command.id}`;
    const journal = { ...original.journal, id: identifier<"JournalTransaction">(correctionId), kind: "reversing" as const,
      postings: original.journal.postings.map((posting, index) => ({ ...posting,
        id: identifier<"Posting">(`${correctionId}-${index}`),
        units: { ...posting.units, canonicalNumber: posting.units.canonicalNumber.negate() },
        bookValue: { ...posting.bookValue, amount: ExactDecimal.of(-posting.bookValue.amount.coefficient, posting.bookValue.amount.scale) },
      })),
    };
    const reversed = resolveJournal(journal, next.state.policies, next.state.identity.ownerId,
      next.state.quantizationPolicies[0]!, journal.postings.map(posting => posting.bookValue.amount.toRational()));
    if (!("journal" in reversed)) throw new Error("Expected exact currency journal reversal");
    const generic = sealCommand({ ...coreCommand(next.state, correctionId, command.issuedAt), type: "correctJournal" as const,
      originalJournalId: original.journal.id, correctionKind: "reversal" as const,
      resolved: { ...reversed, derivations: original.derivations },
    });
    const denied = executeBookCommand(next.state, next.protocol, generic);
    expect(denied.result.disposition).toBe("rejected");
    expect(denied.result.diagnostics[0]?.code).toBe("invalid_correction_topology");
    expect(denied.state.bookRevision).toBe(next.state.bookRevision);
    expect(evaluateCurrentBookCommand({ ...currencyContext(next.state, next.protocol, generic),
      correctionFacts: { originalJournal: original, alreadyCorrected: false, currencySource: true, managedSource: false },
    }, generic).result).toEqual(denied.result);
  }
  return next;
}

/** Real complete fixture observations, not a sparse BookState. The current
 * preparer must produce the same canonical effects as full-book execution. */
function currencyContext(state: BookState, protocol: BookProtocolState, command: BookCommand): CurrentBookContext {
  const activation = state.revisions.flatMap(revision => revision.effects).find(effect => effect.type === "activation");
  return {
    header: { identity: state.identity, financialIdentityHash: state.financialIdentityHash, status: state.status,
      bookRevision: state.bookRevision, latestPostingSequence: state.latestPostingSequence,
      configurationRevision: state.configurationRevision, configurationHash: state.configurationHash },
    configuration: state.activeConfigurationSnapshot, opening: state.openingBoundary ?? null,
    activationIdentity: activation?.financialIdentityHash ?? null, previousRevision: state.revisions.at(-1) ?? null,
    retainedCommand: id => protocol.retainedResults.find(item => item.commandId === id) ?? null,
    journalIdentity: id => state.journals.some(item => item.journal.id === id) ? "present" : "absent",
    postingIdentity: id => state.journals.some(item => item.journal.postings.some(posting => posting.id === id)) ? "present" : "absent",
    periodStatus: id => state.periodTransitions.filter(item => item.periodId === id).at(-1)?.kind === "close" ? "closed" : "open",
    managedMoneyScope: () => "unmanaged",
    overdueRemeasurement: () => state.accountingState.remeasurementResults.find(result =>
      requiresRemeasurementReversal(command, result, state.accountingPolicySnapshot.policies.find(policy => policy.kind === "currencyRemeasurement" && policy.id === result.policyId)) &&
      !state.accountingState.remeasurementReversals.some(reversal => reversal.originalResultId === result.id)) ?? null,
    currencyFacts: {
      currencyState: state.accountingState,
      accountingIdentity: effect => accountingEffectExists(state.accountingState, effect) ? "present" : "absent",
      originalJournal: id => state.journals.find(item => item.journal.id === id) ?? null,
      sourceJournals: () => state.journals,
      sourceRemeasurement: source => state.accountingState.remeasurementResults.some(result => result.kind === "unrealized" && result.source !== undefined &&
        canonicalPostingSourceIdentity(result.source) === canonicalPostingSourceIdentity(source) &&
        !state.accountingState.remeasurementReversals.some(reversal => reversal.originalResultId === result.id)) ? "active" : "none",
      allocatedSource: source => {
        const key = canonicalPostingSourceIdentity(source);
        const open = state.accountingState.openItems.find(item => item.recognitionSource !== undefined && canonicalPostingSourceIdentity(item.recognitionSource) === key);
        const payment = state.accountingState.settlements.find(item => item.settlementSource !== undefined && canonicalPostingSourceIdentity(item.settlementSource) === key);
        let bookValue = ExactRational.zero(), quantity = ExactRational.zero();
        for (const edge of state.accountingState.settlementAllocations) {
          if (open?.id === edge.openItemId) { bookValue = bookValue.add(edge.allocatedBookValue); quantity = quantity.add(edge.allocatedOpenQuantity); }
          if (payment?.id === edge.settlementId) { bookValue = bookValue.add(edge.allocatedSettlementBookValue!); quantity = quantity.add(edge.allocatedSettlementQuantity); }
        }
        return { bookValue, quantity };
      },
    },
  };
}

describe(`canonical accounting book commands (${executionProfile ?? "legacy"})`, () => {
  test("structural tax grouping is explicitly adopted and preserves legacy receipts through durable replay", () => {
    const rawPolicies: TaxPolicy[] = ([["tax:a:b", "c"], ["tax:a", "b:c"]] as const).map(([id, component]) => ({
      ...taxPolicy, id: policyId(id), roundingLevel: "documentLevel", components: [taxComponent(component, {
        rate: ExactRational.of(1n, 200n), liabilityAccountId: A.ap, recoverableAccountId: A.inputTax,
      })],
    }));
    let current = executeBookCommand(stateWithAccounting(rawPolicies), createBookProtocolState(), activationCommand());
    const command = (id: string, policies: readonly TaxPolicy[]) => {
      const at = policies.some((policy) => policy.groupingAlgorithm !== undefined) ? "2026-01-16T15:00:00Z" : "2026-01-15T14:00:00Z";
      return sealCommand({ ...coreCommand(current.state, id, at),
      type: "postTaxedTransaction" as const, request: { id: taxDeterminationId(id), sourceTransactionId: journalId(`${id}-source`),
        governedAt: instant(at), direction: "purchase" as const, derivation,
        lines: policies.map((policy, index) => ({ lineId: `${id}-line-${index}`, sourcePostingId: postingId(`${id}-source-${index}`),
          counterpartyPostingId: postingId(`${id}-counterparty-${index}`), policyId: policy.id, policyVersion: policy.version,
          statedAmount: one, amountIncludesTax: false, sourceAccountId: A.cost, payableAccountId: A.ap })) } });
    };
    const oldCommand = command("tax-before-grouping", rawPolicies);
    current = run(current, oldCommand);
    const oldReceipt = current.result;
    expect(current.state.accountingState.taxDeterminations.at(-1)!.lines.map((line) => line.components[0]!.quantization.amount.toString())).toEqual(["0.00", "0.01"]);
    const newPolicies: TaxPolicy[] = rawPolicies.map((policy) => ({ ...policy, version: semanticVersion("2.0.0"),
      groupingAlgorithm: "structural-tax-groups-v1", algorithmVersion: semanticVersion("1.1.0"),
      capability: { ...policy.capability, implementationVersion: semanticVersion("1.1.0") } }));
    const replacement = sealCommand({ ...coreCommand(current.state, "tax-grouping-policy", "2026-01-16T14:00:00Z"), type: "replaceConfiguration" as const,
      expectedConfigurationRevision: current.state.configurationRevision, effectiveOn: localDate("2026-01-16"),
      periods: current.state.periods, admissionSnapshot: current.state.admissionSnapshot, policies: current.state.policies,
      quantizationPolicies: current.state.quantizationPolicies,
      accountingPolicies: current.state.accountingPolicySnapshot.policies.map((policy) => newPolicies.find((next) => next.id === policy.id) ?? policy) });
    const invalid = sealCommand({ ...replacement, accountingPolicies: replacement.accountingPolicies.map((policy) =>
      policy.kind === "taxDetermination" && policy.groupingAlgorithm !== undefined
        ? { ...policy, algorithmVersion: semanticVersion("1.0.0"), capability: { ...policy.capability, implementationVersion: semanticVersion("1.0.0") } }
        : policy) });
    const refused = executeBookCommand(current.state, current.protocol, invalid);
    expect(refused.result.disposition).toBe("rejected");
    expect(refused.result.diagnostics[0]?.code).toBe("policy_ambiguity");
    expect(refused.state).toBe(current.state);
    current = run(current, replacement);
    const afterCommand = command("tax-after-grouping", newPolicies);
    const indexed = evaluateCurrentBookCommand({ ...currencyContext(current.state, current.protocol, afterCommand),
      taxFacts: { taxIdentity: () => "absent" } }, afterCommand);
    current = run(current, afterCommand);
    expect(indexed.result).toEqual(current.result);
    expect(indexed.effects).toEqual(current.intent?.effects);
    expect(current.state.accountingState.taxDeterminations.at(-1)!.lines.map((line) => line.components[0]!.quantization.amount.toString())).toEqual(["0.00", "0.00"]);
    const amounts = new Map(current.state.journals.at(-1)!.journal.postings.map((posting) => [posting.accountId, posting.bookValue.amount.toRational().toString()]));
    expect(amounts.get(A.cost)).toBe("2/1");
    expect(amounts.get(A.ap)).toBe("-2/1");
    const encoded = encodeDurableBook({ state: current.state, protocol: current.protocol });
    const restored = decodeDurableBook(encoded);
    if (restored.disposition !== "decoded") throw new Error(restored.message);
    for (const [original, receipt] of [[oldCommand, oldReceipt], [afterCommand, current.result]] as const) {
      const retry = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, original);
      expect(retry.result.disposition).toBe("replayed");
      expect(retry.result.resultHash).toEqual(receipt.resultHash);
      expect(encodeDurableBook({ state: retry.state, protocol: retry.protocol })).toBe(encoded);
    }
  });

  if (executionProfile === STRUCTURAL_SOURCE_IDENTITY_PROFILE) test("ACC-038: settlement closes retained invoice and payment sources despite two later delimiter aliases", () => {
    let current = executeBookCommand(stateWithAccounting(), createBookProtocolState(), activationCommand());
    const source = journal("invoice-a");
    const invoice = { ...source, postings: [{ ...source.postings[0]!, accountId: A.ar }, source.postings[1]!] };
    const open = { id: openItemId("alias-invoice"), bookId: IDS.book, kind: "receivable" as const,
      scope: { externalPartyId: "ALIAS-CUSTOMER", controlAccountId: A.ar },
      recognitionSource: postingReference(invoice, "invoice-b:invoice-c:journal:0"),
      recognizedOn: invoice.accountingDate, denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation };
    current = run(current, sealCommand({ ...coreCommand(current.state, "invoice-b:invoice-c"),
      type: "recognizeOpenItem", request: { value: open }, resolved: resolved(invoice) }));
    current = run(current, sealCommand({ ...coreCommand(current.state, "invoice-c"),
      type: "postJournal", resolved: resolved(journal("invoice-a:invoice-b")) }));
    const paymentTemplate = journal("payment-a");
    const payment = { ...paymentTemplate, postings: paymentTemplate.postings.map((posting, i) => ({ ...posting,
      accountId: i === 0 ? A.ar : IDS.cash,
      units: { ...posting.units, canonicalNumber: posting.units.canonicalNumber.negate() },
      bookValue: { ...posting.bookValue, amount: ExactDecimal.of(-posting.bookValue.amount.coefficient, posting.bookValue.amount.scale) },
    })) };
    current = run(current, sealCommand({ ...coreCommand(current.state, "payment-b:payment-c"),
      type: "postJournal", resolved: resolved(payment) }));
    current = run(current, sealCommand({ ...coreCommand(current.state, "payment-c"),
      type: "postJournal", resolved: resolved(journal("payment-a:payment-b")) }));
    for (const offset of [0, 2]) {
      const first = current.state.journals[offset]!, second = current.state.journals[offset + 1]!;
      expect(`${first.journal.id}:${first.effectKey}`).toBe(`${second.journal.id}:${second.effectKey}`);
      expect(first.journal.postings[0]!.id).not.toBe(second.journal.postings[0]!.id);
    }
    const settlement = { id: settlementId("alias-payment"), bookId: IDS.book, kind: "cash" as const,
      scope: open.scope, settlementSource: postingReference(payment, "payment-b:payment-c:journal:0"),
      settledAt: payment.economicAt, denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation };
    const allocation = { id: settlementAllocationId("alias-allocation"), openItemId: open.id,
      settlementId: settlement.id, allocatedBookValue: ExactRational.of(100n, 1n),
      allocatedOpenQuantity: ExactRational.of(100n, 1n), allocatedSettlementQuantity: ExactRational.of(100n, 1n), derivation };
    const command = sealCommand({ ...coreCommand(current.state, "alias-settle"), type: "applySettlement" as const,
      request: { settlement, allocations: [allocation] }, resolved: [] });
    for (const source of [
      postingReference(payment, "payment-c:journal:0"),
      postingReference({ ...payment, postings: [{ ...payment.postings[0]!, accountId: IDS.cash }, payment.postings[1]!] }, settlement.settlementSource.effectKey),
    ]) {
      const invalid = sealCommand({ ...command, request: { ...command.request, settlement: { ...settlement, settlementSource: source } } });
      const rejected = executeBookCommand(current.state, current.protocol, invalid);
      expect(rejected.result.disposition).toBe("rejected");
      expect(rejected.result.diagnostics[0]!.code).toBe("unresolved_accounting_input");
      expect(rejected.state).toBe(current.state);
    }
    const next = run(current, command);
    expect(next.intent!.effects.map(effect => effect.type)).toEqual(["settlement", "settlementAllocation"]);
    expect(next.state.latestPostingSequence).toBe(4n);
    expect(next.state.accountingState.settlements[0]!.settlementSource).toEqual(settlement.settlementSource);
    expect(next.state.accountingState.settlementAllocations.map(value => value.allocatedBookValue.toString())).toEqual(["100/1"]);
    const bytes = encodeDurableBook({ state: next.state, protocol: next.protocol });
    const decoded = decodeDurableBook(bytes);
    expect(decoded.disposition).toBe("decoded");
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    const replay = executeBookCommand(decoded.aggregate.state, decoded.aggregate.protocol, command);
    expect(replay.result).toEqual({ ...next.result, disposition: "replayed" });
    expect(encodeDurableBook({ state: replay.state, protocol: replay.protocol })).toBe(bytes);
  });

  if (executionProfile === STRUCTURAL_SOURCE_IDENTITY_PROFILE) test("ACC-038: retained FX source survives a later delimiter alias through reversal and durable replay", () => {
    let current = executeBookCommand(stateWithAccounting(), createBookProtocolState(), activationCommand());
    const template = journal("source-a");
    const source = { ...template, postings: template.postings.map((posting, i) => ({ ...posting,
      accountId: i === 0 ? A.ar : IDS.revenue,
      units: { canonicalNumber: ExactRational.of(i === 0 ? 40n : -40n, 1n), commodityId: "GBP" as never },
    })) };
    current = run(current, sealCommand({ ...coreCommand(current.state, "source-b:source-c"),
      type: "postJournal", resolved: resolved(source) }));
    const reference = postingReference(source, "source-b:source-c:journal:0");
    current = run(current, sealCommand({ ...coreCommand(current.state, "source-c"),
      type: "postJournal", resolved: resolved(journal("source-a:source-b")) }));
    const [original, unrelated] = current.state.journals;
    expect(`${original!.journal.id}:${original!.effectKey}`).toBe(`${unrelated!.journal.id}:${unrelated!.effectKey}`);
    expect(original!.canonicalHash).not.toEqual(unrelated!.canonicalHash);
    const at = instant("2026-01-31T13:00:00Z");
    const command = sealCommand({ ...coreCommand(current.state, "alias-fx", at), type: "postCurrencyRemeasurement" as const,
      request: { id: remeasurementResultId("alias-fx"), policyId: currencyPolicy.id, policyVersion: currencyPolicy.version,
        classificationPolicyId: monetaryPolicy.id, classificationPolicyVersion: monetaryPolicy.version,
        governedAt: at, kind: "unrealized" as const, classification: "monetary" as const, source: reference,
        generatedEffectKey: effectKey("alias-fx:journal:0"), effectiveOn: localDate("2026-01-31"),
        denominationCommodityId: "GBP" as never, denomination: ExactRational.of(40n, 1n),
        carryingBookValue: ExactRational.of(100n, 1n), positionAccountId: A.ar,
        valuationPath: { fromCommodityId: "GBP" as never, toCommodityId: IDS.usd, effectiveAt: at,
          observedAt: at, rate: ExactRational.of(3n, 1n), evidenceIds: [evidence.id] }, derivation } });
    for (const invalidSource of [
      postingReference({ ...source, postings: [{ ...source.postings[0]!, accountId: IDS.cash }, source.postings[1]!] }, reference.effectKey),
      postingReference(source, unrelated!.effectKey),
      { ...reference, postingContentHash: { ...reference.postingContentHash, algorithm: "forged" as never } },
    ]) {
      const invalid = sealCommand({ ...command, request: { ...command.request, source: invalidSource } });
      const rejected = executeBookCommand(current.state, current.protocol, invalid);
      expect(rejected.result.disposition).toBe("rejected");
      expect(rejected.result.diagnostics[0]!.code).toBe("unresolved_accounting_input");
      expect(rejected.state).toBe(current.state);
      expect(evaluateCurrentBookCommand(currencyContext(current.state, current.protocol, invalid), invalid).result).toEqual(rejected.result);
    }
    const measured = run(current, command);
    expect(measured.state.journals.at(-1)!.journal.postings.map(posting => posting.bookValue.amount.toRational().toString()))
      .toEqual(["20/1", "-20/1"]);
    expect(measured.state.accountingState.remeasurementResults[0]!.source).toEqual(reference);
    const reversed = run(measured, sealCommand({ ...command, ...coreCommand(measured.state, "alias-fx-reverse", at),
      request: { ...command.request, reversalOf: command.request.id,
        reversalId: remeasurementReversalId("alias-fx-reverse"), generatedEffectKey: effectKey("alias-fx-reverse:journal:0") } }));
    expect(reversed.state.journals.at(-1)!.journal.postings.map(posting => posting.bookValue.amount.toRational().toString()))
      .toEqual(["-20/1", "20/1"]);
    const bytes = encodeDurableBook({ state: reversed.state, protocol: reversed.protocol });
    const restored = decodeDurableBook(bytes);
    expect(restored.disposition).toBe("decoded");
    if (restored.disposition !== "decoded") throw new Error(restored.message);
    const retried = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, command);
    expect(retried.result.disposition).toBe("replayed");
    expect(retried.result.resultHash).toEqual(measured.result.resultHash);
    expect(encodeDurableBook({ state: retried.state, protocol: retried.protocol })).toBe(bytes);
  });

  test("structural profile authenticates same-command open-item sources including raw coordinates and full hashes", () => {
    const base = stateWithAccounting();
    const c = base.activeConfigurationSnapshot;
    const selected = createBookState(base.identity, c.periods, c.admissionSnapshot, c.policies,
      c.quantizationPolicies, c.accountingPolicySnapshot.policies, c.effectiveAt, STRUCTURAL_SOURCE_IDENTITY_PROFILE);
    let current = executeBookCommand(selected, createBookProtocolState(), activationCommand());
    // This prior journal aliases the raw key of the next command's prepared journal.
    current = run(current, sealCommand({ ...coreCommand(current.state, "c"), type: "postJournal", resolved: resolved(journal("a:b")) }));
    const source = journal("a");
    const recognition = { ...source, postings: [{ ...source.postings[0]!, accountId: A.ar }, source.postings[1]!] };
    const reference = postingReference(recognition, "b:c:journal:0");
    const value = { id: openItemId("structural-open-item"), bookId: IDS.book, kind: "receivable" as const,
      scope: { externalPartyId: "STRUCTURAL-CUSTOMER", controlAccountId: A.ar }, recognitionSource: reference,
      recognizedOn: recognition.accountingDate, denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation };
    const template = sealCommand({ ...coreCommand(current.state, "b:c"), type: "recognizeOpenItem" as const,
      request: { value }, resolved: resolved(recognition) });
    const next = run(current, template);
    expect(next.state.accountingState.openItems[0]?.recognitionSource).toEqual(reference);
    expect(next.state.journals).toHaveLength(2);
    expect(validateBookState(next.state)).toEqual([]);
    expect(decodeDurableBook(encodeDurableBook({ state: next.state, protocol: next.protocol })).disposition).toBe("decoded");
    for (const invalid of [
      postingReference(recognition, "wrong-effect"),
      postingReference({ ...recognition, id: journalId("missing-journal") }, "b:c:journal:0"),
      postingReference({ ...recognition, postings: [{ ...recognition.postings[0]!, id: postingId("missing-posting") }, recognition.postings[1]!] }, "b:c:journal:0"),
      postingReference({ ...recognition, postings: [{ ...recognition.postings[0]!, bookValue: { ...recognition.postings[0]!.bookValue, amount: ExactDecimal.of(101n, 0n) } }, recognition.postings[1]!] }, "b:c:journal:0"),
      { ...reference, postingContentHash: { ...reference.postingContentHash, algorithm: "forged" as never } },
      { ...reference, postingContentHash: { ...reference.postingContentHash, canonicalizationVersion: "forged" as never } },
      { ...reference, postingContentHash: { ...reference.postingContentHash, digest: "0".repeat(64) } },
    ]) {
      const result = executeBookCommand(current.state, current.protocol, sealCommand({ ...template, request: { value: { ...value, recognitionSource: invalid } } }));
      expect(result.result.disposition).toBe("rejected");
      expect(result.state.contentHash).toEqual(current.state.contentHash);
      expect(result.result.diagnostics.some((d) => d.code === "unresolved_accounting_input")).toBeTrue();
    }
  });

  test("ACC-041.4/6: three-currency receivables and payables clear with gross gain/loss lineage", () => {
    const cases = [
      { name: "gain", carrying: [100n], paid: 120n, gain: 20n, loss: 0n },
      { name: "loss", carrying: [100n], paid: 80n, gain: 0n, loss: 20n },
      { name: "zero-and-gain", carrying: [60n, 40n], paid: 120n, gain: 20n, loss: 0n },
      { name: "offsetting", carrying: [50n, 70n], paid: 120n, gain: 10n, loss: 10n },
    ];
    for (const kind of ["receivable", "payable"] as const) for (const example of cases) {
      const base = stateWithAccounting();
      const initial = createBookState(identity, periods, base.admissionSnapshot, [policy], [quantizationPolicy], accountingPolicies.map(p => p.kind === "monetaryClassification" ? { ...monetaryPolicy, rules: [...monetaryPolicy.rules, classificationRule("signed-ap", "ap", "monetary")] } : p.kind === "currencyRemeasurement" ? { ...currencyPolicy, reversalRequired: kind === "receivable" } : p), instant("2020-01-01T00:00:00Z"));
      let current = executeBookCommand(initial, createBookProtocolState(), activationCommand("signed-fx-activate"));
      let outstandingRemeasurement: AtomicBookCommit | undefined;
      const control = kind === "receivable" ? A.ar : A.ap;
      const sign = kind === "receivable" ? 1n : -1n;
      const openIds = example.carrying.map((_, i) => openItemId(`signed-open-${i}`));
      for (const [i, carrying] of example.carrying.entries()) {
        const source = journal(`signed-open-${i}`);
        const transaction = { ...source, postings: source.postings.map((p, j) => ({ ...p, accountId: j === 0 ? control : IDS.revenue, units: { canonicalNumber: ExactRational.of((j === 0 ? sign : -sign) * 40n, 1n), commodityId: "GBP" as never }, bookValue: { amount: ExactDecimal.of((j === 0 ? sign : -sign) * carrying * 100n, 2n), functionalCommodityId: IDS.usd } })) };
        const value = { id: openIds[i]!, bookId: IDS.book, kind, scope: { externalPartyId: "SIGNED-FX", controlAccountId: control }, recognitionSource: postingReference(transaction, `signed-open-${i}:journal:0`), recognizedOn: transaction.accountingDate, denominationCommodityId: "GBP" as never, denomination: ExactRational.of(40n, 1n), bookValue: ExactRational.of(carrying, 1n), derivation };
        current = run(current, sealCommand({ ...coreCommand(current.state, `signed-open-${i}`), type: "recognizeOpenItem" as const, request: { value }, resolved: resolved(transaction) }));
      }
      if (example.name === "gain") {
        const source = current.state.accountingState.openItems[0]!.recognitionSource!;
        const command = sealCommand({ ...coreCommand(current.state, "signed-remeasurement", "2026-01-31T13:00:00Z"), type: "postCurrencyRemeasurement" as const, request: { id: remeasurementResultId("signed-remeasurement"), policyId: currencyPolicy.id, policyVersion: currencyPolicy.version, classificationPolicyId: monetaryPolicy.id, classificationPolicyVersion: monetaryPolicy.version, governedAt: instant("2026-01-31T13:00:00Z"), kind: "unrealized" as const, classification: "monetary" as const, source, generatedEffectKey: "signed-remeasurement:journal:0" as never, effectiveOn: localDate("2026-01-31"), denominationCommodityId: "GBP" as never, denomination: ExactRational.of(sign * 40n, 1n), carryingBookValue: ExactRational.of(sign * 100n, 1n), valuationPath: { fromCommodityId: "GBP" as never, toCommodityId: IDS.usd, effectiveAt: instant("2026-01-31T13:00:00Z"), observedAt: instant("2026-01-31T12:00:00Z"), rate: ExactRational.of(3n, 1n), evidenceIds: [evidence.id] }, positionAccountId: control, derivation } });
        const measured = run(current, command);
        outstandingRemeasurement = measured;
        const repeated = executeBookCommand(measured.state, measured.protocol, sealCommand({ ...command, ...coreCommand(measured.state, "signed-repeated", "2026-01-31T14:00:00Z"), request: { ...command.request, id: remeasurementResultId("signed-repeated"), generatedEffectKey: "signed-repeated:journal:0" as never } }));
        expect(repeated.result.disposition).toBe("rejected");
        expect(repeated.result.diagnostics[0]!.path).toEndWith("remeasurement");
        expect(repeated.state.contentHash).toEqual(measured.state.contentHash);
        const reversed = run(measured, sealCommand({ ...command, ...coreCommand(measured.state, "signed-reversal", "2026-01-31T14:00:00Z"), request: { ...command.request, reversalOf: command.request.id, reversalId: remeasurementReversalId("signed-reversal"), generatedEffectKey: "signed-reversal:journal:0" as never } }));
        const measuredAgain = run(reversed, sealCommand({ ...command, ...coreCommand(reversed.state, "signed-measured-again", "2026-01-31T14:00:00Z"), request: { ...command.request, id: remeasurementResultId("signed-measured-again"), generatedEffectKey: "signed-measured-again:journal:0" as never } }));
        expect(measuredAgain.state.journals.at(-1)!.journal.postings.map(p => p.bookValue.amount.toRational().toString())).toEqual([`${sign * 20n}/1`, `${-sign * 20n}/1`]);
        expect(decodeDurableBook(encodeDurableBook({ state: measuredAgain.state, protocol: measuredAgain.protocol })).disposition).toBe("decoded");
        expect(measured.state.journals.at(-1)!.journal.postings.map(p => p.bookValue.amount.toRational().toString())).toEqual([`${sign * 20n}/1`, `${-sign * 20n}/1`]);
        expect(measured.state.journals.at(-1)!.journal.postings[1]!.accountId).toBe(kind === "receivable" ? A.gain : A.loss);
        for (const request of [
          { ...command.request, denomination: command.request.denomination.negate(), carryingBookValue: command.request.carryingBookValue.negate() },
          { ...command.request, denomination: ExactRational.of(sign * 41n, 1n) },
        ]) {
          const invalid = executeBookCommand(current.state, current.protocol, sealCommand({ ...command, request }));
          expect(invalid.result.disposition).toBe("rejected");
          expect(invalid.result.diagnostics[0]!.message).toStartWith("Currency remeasurement must resolve");
          expect(invalid.state.contentHash).toEqual(current.state.contentHash);
        }
        expect(decodeDurableBook(encodeDurableBook({ state: measured.state, protocol: measured.protocol })).disposition).toBe("decoded");
      }
      const payment = journal("signed-payment", "2026-01-31");
      const paymentJournal = { ...payment, postings: payment.postings.map((p, i) => ({ ...p, accountId: i === 0 ? control : IDS.cash, units: { canonicalNumber: ExactRational.of((i === 0 ? -sign : sign) * 100n, 1n), commodityId: "EUR" as never }, bookValue: { amount: ExactDecimal.of((i === 0 ? -sign : sign) * example.paid * 100n, 2n), functionalCommodityId: IDS.usd } })) };
      const settledAt = instant("2026-01-31T14:00:00Z");
      const settlement = { id: settlementId("signed-payment"), bookId: IDS.book, kind: "cash" as const, scope: { externalPartyId: "SIGNED-FX", controlAccountId: control }, settlementSource: postingReference(paymentJournal, "signed-payment:journal:0"), settledAt, denominationCommodityId: "EUR" as never, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(example.paid, 1n), derivation };
      const allocations = example.carrying.map((carrying, i) => ({ id: settlementAllocationId(`signed-allocation-${i}`), openItemId: openIds[i]!, settlementId: settlement.id, allocatedBookValue: ExactRational.of(carrying, 1n), allocatedOpenQuantity: ExactRational.of(40n, 1n), allocatedSettlementQuantity: ExactRational.of(100n, BigInt(example.carrying.length)), valuationPath: { fromCommodityId: "EUR" as never, toCommodityId: IDS.usd, effectiveAt: settledAt, observedAt: settledAt, rate: ExactRational.of(example.paid, 100n), evidenceIds: [evidence.id] }, ...(example.paid / BigInt(example.carrying.length) === carrying ? {} : { realizedExchangeEffectKey: "signed-payment:journal:1" as never }), derivation }));
      const command = sealCommand({ ...coreCommand(current.state, "signed-payment", "2026-01-31T15:00:00Z"), type: "applySettlement" as const, request: { settlement, allocations }, resolved: [resolved(paymentJournal)] });
      if (outstandingRemeasurement !== undefined) {
        const invalid = executeBookCommand(outstandingRemeasurement.state, outstandingRemeasurement.protocol, sealCommand({ ...command, expectedBookRevision: outstandingRemeasurement.state.bookRevision }));
        expect(invalid.result.disposition).toBe("rejected");
        expect(invalid.result.diagnostics[0]!.path).toEndWith("remeasurement");
        expect(invalid.state.contentHash).toEqual(outstandingRemeasurement.state.contentHash);
        const half = ExactRational.of(1n, 2n);
        const halfJournal = { ...paymentJournal, postings: paymentJournal.postings.map(p => ({ ...p, units: { ...p.units, canonicalNumber: p.units.canonicalNumber.multiply(half) }, bookValue: { ...p.bookValue, amount: ExactDecimal.of(p.bookValue.amount.coefficient / 2n, p.bookValue.amount.scale) } })) };
        const partial = run(current, sealCommand({ ...command, request: { settlement: { ...settlement, denomination: settlement.denomination.multiply(half), bookValue: settlement.bookValue.multiply(half), settlementSource: postingReference(halfJournal, "signed-payment:journal:0") }, allocations: allocations.map(a => ({ ...a, allocatedBookValue: a.allocatedBookValue.multiply(half), allocatedOpenQuantity: a.allocatedOpenQuantity.multiply(half), allocatedSettlementQuantity: a.allocatedSettlementQuantity.multiply(half) })) }, resolved: [resolved(halfJournal)] }));
        const original = outstandingRemeasurement.protocol.retainedResults.at(-1)!.command;
        if (original.type !== "postCurrencyRemeasurement") throw new Error("Expected remeasurement fixture");
        const remaining = run(partial, sealCommand({ ...original, ...times("2026-01-31T16:00:00Z"), expectedBookRevision: partial.state.bookRevision, request: { ...original.request, denomination: original.request.denomination.multiply(half), carryingBookValue: original.request.carryingBookValue.multiply(half) } }));
        expect(remaining.state.journals.at(-1)!.journal.postings.map(p => p.bookValue.amount.toRational().toString())).toEqual([`${sign * 10n}/1`, `${-sign * 10n}/1`]);
        expect(decodeDurableBook(encodeDurableBook({ state: remaining.state, protocol: remaining.protocol })).disposition).toBe("decoded");
        const stale = executeBookCommand(partial.state, partial.protocol, sealCommand({ ...original, ...times("2026-01-31T16:00:00Z"), expectedBookRevision: partial.state.bookRevision }));
        expect(stale.result.disposition).toBe("rejected");
        expect(stale.result.diagnostics[0]!.message).toStartWith("Currency remeasurement must resolve");
      }
      const wrongSignJournal = { ...paymentJournal, postings: paymentJournal.postings.map(p => ({ ...p, units: { ...p.units, canonicalNumber: p.units.canonicalNumber.negate() }, bookValue: { ...p.bookValue, amount: ExactDecimal.of(-p.bookValue.amount.coefficient, p.bookValue.amount.scale) } })) };
      const wrongSign = executeBookCommand(current.state, current.protocol, sealCommand({ ...command, request: { ...command.request, settlement: { ...settlement, settlementSource: postingReference(wrongSignJournal, "signed-payment:journal:0") } }, resolved: [resolved(wrongSignJournal)] }));
      expect(wrongSign.result.disposition).toBe("rejected");
      expect(wrongSign.result.diagnostics[0]!.path).toEndWith("settlementDirection");
      expect(wrongSign.state.contentHash).toEqual(current.state.contentHash);
      // The same carrying-value arithmetic must hold when payment recognition
      // and application are separate commands in different accounting periods.
      const unallocated = run(current, sealCommand({ ...command,
        request: { settlement, operation: "recognizeUnallocated", allocations: [] },
      }));
      const laterAt = instant("2026-02-01T15:00:00Z");
      const laterCommand = sealCommand({ ...coreCommand(unallocated.state, "signed-later", laterAt),
        type: "applySettlement" as const, resolved: [], request: {
          operation: "allocateExisting" as const, appliedAt: laterAt, settlement,
          allocations: allocations.map(edge => ({ ...edge,
            ...(edge.realizedExchangeEffectKey === undefined ? {} : { realizedExchangeEffectKey: "signed-later:journal:0" as never }),
          })),
        },
      });
      const appliedLater = run(unallocated, laterCommand);
      const half = ExactRational.of(1n, 2n);
      const halfApplication = sealCommand({ ...laterCommand, request: { ...laterCommand.request,
        allocations: laterCommand.request.allocations.map(edge => ({ ...edge,
          allocatedBookValue: edge.allocatedBookValue.multiply(half),
          allocatedOpenQuantity: edge.allocatedOpenQuantity.multiply(half),
          allocatedSettlementQuantity: edge.allocatedSettlementQuantity.multiply(half),
        })),
      } });
      const partiallyApplied = run(unallocated, halfApplication);
      const measuredAt = instant("2026-02-01T16:00:00Z");
      const remainingPayment = sealCommand({ ...coreCommand(partiallyApplied.state, "remaining-payment", measuredAt), type: "postCurrencyRemeasurement" as const,
        request: { id: remeasurementResultId("remaining-payment"), policyId: currencyPolicy.id, policyVersion: currencyPolicy.version,
          classificationPolicyId: monetaryPolicy.id, classificationPolicyVersion: monetaryPolicy.version,
          governedAt: measuredAt, kind: "unrealized" as const, classification: "monetary" as const,
          source: createCanonicalPostingReference(canonicalPostingReferenceId("alternate-payment-reference"), IDS.book, paymentJournal.id, paymentJournal.postings[0]!, settlement.settlementSource.effectKey),
          generatedEffectKey: "remaining-payment:journal:0" as never,
          effectiveOn: localDate("2026-02-01"), denominationCommodityId: settlement.denominationCommodityId,
          denomination: ExactRational.of(-sign * 50n, 1n), carryingBookValue: ExactRational.of(-sign * example.paid, 2n),
          valuationPath: { fromCommodityId: settlement.denominationCommodityId, toCommodityId: IDS.usd,
            effectiveAt: measuredAt, observedAt: measuredAt, rate: ExactRational.of(example.paid + 20n, 100n), evidenceIds: [evidence.id] },
          positionAccountId: control, derivation },
      });
      const remainingMeasured = run(partiallyApplied, remainingPayment);
      expect(remainingMeasured.state.journals.at(-1)!.journal.postings.map(p => p.bookValue.amount.toRational().toString()))
        .toEqual([`${-sign * 10n}/1`, `${sign * 10n}/1`]);
      expect(decodeDurableBook(encodeDurableBook({ state: remainingMeasured.state, protocol: remainingMeasured.protocol })).disposition).toBe("decoded");
      const stalePayment = executeBookCommand(partiallyApplied.state, partiallyApplied.protocol, sealCommand({ ...remainingPayment,
        request: { ...remainingPayment.request, denomination: ExactRational.of(-sign * 100n, 1n), carryingBookValue: ExactRational.of(-sign * example.paid, 1n) },
      }));
      expect(stalePayment.result.disposition).toBe("rejected");
      expect(stalePayment.result.diagnostics[0]?.code).toBe("unresolved_accounting_input");
      expect(stalePayment.state.contentHash).toEqual(partiallyApplied.state.contentHash);
      // Immediate allocations and mixed immediate/later applications consume
      // the same payment budget; this is not a special case for dated edges.
      const immediateHalf = run(current, sealCommand({ ...command,
        request: { ...command.request, allocations: command.request.allocations.map(edge => ({ ...edge,
          allocatedBookValue: edge.allocatedBookValue.multiply(half),
          allocatedOpenQuantity: edge.allocatedOpenQuantity.multiply(half),
          allocatedSettlementQuantity: edge.allocatedSettlementQuantity.multiply(half),
        })) },
      }));
      const immediateMeasured = run(immediateHalf, sealCommand({ ...remainingPayment, ...coreCommand(immediateHalf.state, "remaining-payment", measuredAt) }));
      expect(immediateMeasured.state.journals.at(-1)!.journal.postings.map(p => p.bookValue.amount.toRational().toString()))
        .toEqual([`${-sign * 10n}/1`, `${sign * 10n}/1`]);
      expect(decodeDurableBook(encodeDurableBook({ state: immediateMeasured.state, protocol: immediateMeasured.protocol })).disposition).toBe("decoded");
      const mixed = run(immediateHalf, sealCommand({ ...halfApplication, ...coreCommand(immediateHalf.state, "quarter-apply", laterAt),
        request: { ...halfApplication.request, allocations: halfApplication.request.allocations.map((edge, index) => ({ ...edge,
          id: settlementAllocationId(`quarter-edge-${index}`),
          allocatedBookValue: edge.allocatedBookValue.multiply(half),
          allocatedOpenQuantity: edge.allocatedOpenQuantity.multiply(half),
          allocatedSettlementQuantity: edge.allocatedSettlementQuantity.multiply(half),
          ...(edge.realizedExchangeEffectKey === undefined ? {} : { realizedExchangeEffectKey: "quarter-apply:journal:0" as never }),
        })) },
      }));
      const mixedMeasured = run(mixed, sealCommand({ ...remainingPayment, ...coreCommand(mixed.state, "remaining-payment", measuredAt),
        request: { ...remainingPayment.request, denomination: ExactRational.of(-sign * 25n, 1n), carryingBookValue: ExactRational.of(-sign * example.paid, 4n) },
      }));
      expect(mixedMeasured.state.journals.at(-1)!.journal.postings.map(p => p.bookValue.amount.toRational().toString()))
        .toEqual([`${-sign * 5n}/1`, `${sign * 5n}/1`]);
      expect(decodeDurableBook(encodeDurableBook({ state: mixedMeasured.state, protocol: mixedMeasured.protocol })).disposition).toBe("decoded");
      const applicationAt = instant("2026-02-01T17:00:00Z");
      const blockedApplication = executeBookCommand(remainingMeasured.state, remainingMeasured.protocol, sealCommand({
        ...halfApplication, ...coreCommand(remainingMeasured.state, "remaining-apply", applicationAt),
        request: { ...halfApplication.request, appliedAt: applicationAt,
          allocations: halfApplication.request.allocations.map((edge, index) => ({ ...edge,
            id: settlementAllocationId(`remaining-edge-${index}`),
            ...(edge.realizedExchangeEffectKey === undefined ? {} : { realizedExchangeEffectKey: "remaining-apply:journal:0" as never }),
          })),
        },
      }));
      expect(blockedApplication.result.disposition).toBe("rejected");
      expect(blockedApplication.result.diagnostics[0]?.path).toEndWith("remeasurement");
      expect(blockedApplication.state.contentHash).toEqual(remainingMeasured.state.contentHash);
      const repeatedMeasurement = executeBookCommand(remainingMeasured.state, remainingMeasured.protocol, sealCommand({
        ...remainingPayment, ...coreCommand(remainingMeasured.state, "repeated-payment", applicationAt),
        request: { ...remainingPayment.request, id: remeasurementResultId("repeated-payment"),
          source: settlement.settlementSource, generatedEffectKey: "repeated-payment:journal:0" as never },
      }));
      expect(repeatedMeasurement.result.disposition).toBe("rejected");
      expect(repeatedMeasurement.result.diagnostics[0]?.path).toEndWith("remeasurement");
      const reversedPayment = run(blockedApplication, sealCommand({
        ...remainingPayment, ...coreCommand(blockedApplication.state, "reverse-payment", applicationAt),
        request: { ...remainingPayment.request, governedAt: applicationAt,
          reversalOf: remainingPayment.request.id, reversalId: remeasurementReversalId("reverse-payment"),
          generatedEffectKey: "reverse-payment:journal:0" as never },
      }));
      const finishedAt = instant("2026-02-01T18:00:00Z");
      const finishedPayment = run(reversedPayment, sealCommand({
        ...halfApplication, ...coreCommand(reversedPayment.state, "after-reverse-apply", finishedAt),
        request: { ...halfApplication.request, appliedAt: finishedAt,
          allocations: halfApplication.request.allocations.map((edge, index) => ({ ...edge,
            id: settlementAllocationId(`finished-edge-${index}`),
            ...(edge.realizedExchangeEffectKey === undefined ? {} : { realizedExchangeEffectKey: "after-reverse-apply:journal:0" as never }),
          })),
        },
      }));
      expect(finishedPayment.state.accountingState.settlementAllocations.reduce((sum, edge) => sum.add(edge.allocatedSettlementQuantity), ExactRational.zero()).toString()).toBe("100/1");
      expect(decodeDurableBook(encodeDurableBook({ state: finishedPayment.state, protocol: finishedPayment.protocol })).disposition).toBe("decoded");
      const laterJournal = appliedLater.state.journals.at(-1)!.journal;
      expect(laterJournal.accountingDate).toBe(localDate("2026-02-01"));
      expect(laterJournal.economicAt).toBe(laterAt);
      expect(appliedLater.state.accountingState.settlements[0]!.contentHash).toEqual(unallocated.state.accountingState.settlements[0]!.contentHash);
      expect(appliedLater.state.accountingState.settlementAllocations.every(edge => edge.appliedAt === laterAt)).toBeTrue();
      expect(decodeDurableBook(encodeDurableBook({ state: appliedLater.state, protocol: appliedLater.protocol })).disposition).toBe("decoded");
      current = run(current, command);
      expect(laterJournal.postings.map(p => [p.accountId, p.bookValue.amount.toRational().toString()]))
        .toEqual(current.state.journals.at(-1)!.journal.postings.map(p => [p.accountId, p.bookValue.amount.toRational().toString()]));
      const balance = (accountId: typeof control) => current.state.journals.flatMap(j => j.journal.postings).filter(p => p.accountId === accountId).reduce((sum, p) => sum.add(p.bookValue.amount.toRational()), ExactRational.zero());
      expect(balance(control).toString(), `${kind}/${example.name} control clears`).toBe("0/1");
      const gain = kind === "receivable" ? example.gain : example.loss;
      const loss = kind === "receivable" ? example.loss : example.gain;
      expect(balance(A.gain).toString()).toBe(`${-gain}/1`);
      expect(balance(A.loss).toString()).toBe(`${loss}/1`);
      const generated = current.state.journals.at(-1)!;
      expect(generated.effectKey).toBe("signed-payment:journal:1" as never);
      expect(generated.journal.postings.every(p => !p.bookValue.amount.toRational().isZero())).toBeTrue();
      expect(current.state.accountingState.settlementAllocations.filter(a => a.realizedExchangeEffectKey !== undefined).every(a => a.realizedExchangeEffectKey === generated.effectKey)).toBeTrue();
      expect(decodeDurableBook(encodeDurableBook({ state: current.state, protocol: current.protocol })).disposition).toBe("decoded");
      let replay = { state: initial, protocol: createBookProtocolState() };
      for (const retained of current.protocol.retainedResults) replay = executeBookCommand(replay.state, replay.protocol, retained.command);
      expect(replay.state.contentHash).toEqual(current.state.contentHash);
    }
  }, 60000);

  test("ACC-041/043: settlement policy intervals and optional FX selection have exact boundaries", () => {
    for (const scenario of ["quantization-start", "quantization-end", "quantization-switch", "currency-start", "currency-end", "implicit-selection"] as const) {
      const at = instant("2026-01-31T14:00:00Z");
      const q = { ...quantizationPolicy, ...(scenario === "quantization-start" ? { validFrom: localDate("2026-01-15") } : {}), ...(scenario === "quantization-end" || scenario === "quantization-switch" ? { validTo: localDate("2026-01-31") } : {}) };
      const nextQ = { ...quantizationPolicy, id: quantizationPolicyId("next-settlement-quantization"), validFrom: localDate("2026-01-31") };
      const fx = { ...currencyPolicy, ...(scenario === "currency-start" ? { validFrom: at } : {}), ...(scenario === "currency-end" ? { validTo: at } : {}) };
      const base = stateWithAccounting();
      const state = createBookState(identity, periods, base.admissionSnapshot, [policy], scenario === "quantization-switch" ? [q, nextQ] : [q], accountingPolicies.map(p => p.kind === "currencyRemeasurement" ? fx : p), instant("2020-01-01T00:00:00Z"));
      let current = executeBookCommand(state, createBookProtocolState(), activationCommand(`boundary-${scenario}-activate`));
      const openJournal = { ...journal("boundary-open"), postings: journal("boundary-open").postings.map((p, i) => ({ ...p, accountId: i === 0 ? A.ar : IDS.revenue })) };
      const openValue = { id: openItemId("boundary-open"), bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "CUSTOMER", controlAccountId: A.ar }, recognitionSource: postingReference(openJournal, "boundary-open:journal:0"), recognizedOn: openJournal.accountingDate, denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation };
      const resolve = (journal: Parameters<typeof resolved>[0]) => {
        const result = resolveJournal(journal, [policy], IDS.owner, scenario === "quantization-switch" && journal.accountingDate >= nextQ.validFrom ? nextQ : q, journal.postings.map(p => p.bookValue.amount.toRational()));
        expect(Array.isArray(result)).toBeFalse();
        if (Array.isArray(result)) throw new Error("Boundary fixture journal did not resolve");
        return result as ResolvedTransaction;
      };
      current = run(current, sealCommand({ ...coreCommand(current.state, "boundary-open"), type: "recognizeOpenItem" as const, request: { value: openValue }, resolved: resolve(openJournal) }));
      const date = scenario === "quantization-start" ? "2026-01-15" : "2026-01-31";
      const settledAt = instant(`${date}T14:00:00Z`);
      const settlementJournal = { ...journal("boundary-settlement", date), postings: journal("boundary-settlement", date).postings.map((p, i) => ({ ...p, accountId: i === 0 ? A.ar : IDS.cash, units: { ...p.units, canonicalNumber: p.units.canonicalNumber.negate(), commodityId: "EUR" as never }, bookValue: { ...p.bookValue, amount: ExactDecimal.of(i === 0 ? -12_000n : 12_000n, 2n) } })) };
      const settlement = { id: settlementId("boundary-settlement"), bookId: IDS.book, kind: "cash" as const, scope: openValue.scope, settlementSource: postingReference(settlementJournal, "boundary-settlement:journal:0"), settledAt, denominationCommodityId: "EUR" as never, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(120n, 1n), derivation };
      // The expired-policy branch must reach settlement admission, not fail while constructing the input.
      const supplied = scenario === "quantization-end" ? resolved(settlementJournal) : resolve(settlementJournal);
      const result = executeBookCommand(current.state, current.protocol, sealCommand({ ...coreCommand(current.state, "boundary-settlement", `${date}T15:00:00Z`), type: "applySettlement" as const, request: { settlement, ...(scenario === "implicit-selection" ? {} : { realizedExchangePolicyId: fx.id, realizedExchangePolicyVersion: fx.version }), allocations: [{ id: settlementAllocationId("boundary-allocation"), openItemId: openValue.id, settlementId: settlement.id, allocatedBookValue: ExactRational.of(100n, 1n), allocatedOpenQuantity: ExactRational.of(100n, 1n), allocatedSettlementQuantity: ExactRational.of(100n, 1n), allocatedSettlementBookValue: ExactRational.of(120n, 1n), valuationPath: { fromCommodityId: settlement.denominationCommodityId, toCommodityId: IDS.usd, effectiveAt: settledAt, observedAt: settledAt, rate: ExactRational.of(6n, 5n), evidenceIds: [evidence.id] }, realizedExchangeEffectKey: "boundary-settlement:journal:1" as never, derivation }] }, resolved: [supplied] }));
      if (scenario.endsWith("end")) {
        expect(result.result.disposition, scenario).toBe("rejected");
        expect(result.result.diagnostics[0]!.code).toBe(scenario === "currency-end" ? "currency_remeasurement_violation" : "policy_ambiguity");
        expect(result.state.contentHash).toEqual(current.state.contentHash);
      } else {
        expect(result.result.disposition, `${scenario}: ${result.result.diagnostics[0]?.message}`).toBe("committed");
        expect(result.state.journals.at(-1)!.journal.postings.map(p => p.bookValue.amount.toRational().toString())).toEqual(["20/1", "-20/1"]);
      }
    }
  });

  test("ACC-017/037: generated postings retain their own ordinal's dimensions", () => {
    const base = stateWithAccounting();
    const axis = dimensionId("boundary-department");
    const members = ["source", "tax", "counterparty"].map(name => ({ id: dimensionMemberId(`boundary-${name}`), bookId: IDS.book, dimensionId: axis, code: name, name, openedOn: localDate("2020-01-01") }));
    const state = createBookState(identity, periods, { ...base.admissionSnapshot, dimensions: [{ id: axis, bookId: IDS.book, code: "DEPT", name: "Department", openedOn: localDate("2020-01-01") }], dimensionMembers: members }, [policy], [quantizationPolicy], accountingPolicies, instant("2020-01-01T00:00:00Z"));
    const active = executeBookCommand(state, createBookProtocolState(), activationCommand("dimension-boundary-activate"));
    const command = sealCommand({ ...coreCommand(active.state, "dimension-boundary"), type: "postTaxedTransaction" as const, generatedPostingDimensionSelections: members.map((member, i) => ({ effectKey: "dimension-boundary:journal:0" as never, postingOrdinal: BigInt(i + 1), dimensionMemberIds: [member.id] })).reverse(), request: { id: taxDeterminationId("dimension-boundary-tax"), sourceTransactionId: journalId("dimension-boundary-source"), governedAt: instant("2026-01-15T14:00:00Z"), direction: "purchase" as const, lines: [{ lineId: "dimension-line", sourcePostingId: postingId("dimension-source"), counterpartyPostingId: postingId("dimension-counterparty"), policyId: taxPolicy.id, policyVersion: taxPolicy.version, statedAmount: ExactRational.of(100n, 1n), amountIncludesTax: false, sourceAccountId: A.cost, payableAccountId: A.ap }], derivation } });
    const committed = run(active, command);
    expect(committed.state.journals.at(-1)!.journal.postings.map(p => p.dimensionMemberIds)).toEqual(members.map(m => [m.id]));
  });

  test("admits only complete executable accounting-policy capabilities", () => {
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryValuePolicy, allowedKinds: [] })).toBeFalse();
    const inventoryEnd = instant("2026-01-01T00:00:00Z");
    const baseForLink = stateWithAccounting();
    const expiredLink = createBookState(identity, periods, baseForLink.admissionSnapshot, [policy], [quantizationPolicy], [{ ...inventoryPolicy, validTo: inventoryEnd }, { ...inventoryValuePolicy, validFrom: inventoryEnd }], instant("2020-01-01T00:00:00Z"));
    const linkAdmission = executeBookCommand(expiredLink, createBookProtocolState(), activationCommand("expired-cost-link"));
    expect(linkAdmission.result.disposition).toBe("rejected");
    expect(linkAdmission.result.diagnostics.some(d => d.path === "accountingPolicySnapshot.policies[1]" && d.code === "policy_ambiguity")).toBeTrue();
    for (const executable of accountingPolicies) expect(accountingPolicyCapabilityIsExecutable(executable), executable.kind).toBeTrue();

    const invalidInventory: readonly unknown[] = [
      { ...inventoryPolicy, pools: [] },
      { ...inventoryPolicy, pools: [pool("duplicate-account-a", "inventory"), pool("duplicate-account-b", "inventory")] },
      { ...inventoryPolicy, pools: [pool("duplicate-id", "inventory"), pool("duplicate-id", "cost")] },
      { ...inventoryPolicy, shortageTreatment: "reject", provisionalBasisMethod: "explicitRate", provisionalRate: one },
      { ...inventoryPolicy, shortageTreatment: "reject", provisionalBasisMethod: undefined, provisionalRate: one },
      { ...inventoryPolicy, shortageTreatment: "provisionalNegative", provisionalBasisMethod: undefined, provisionalRate: one },
      { ...inventoryPolicy, shortageTreatment: "provisionalNegative", provisionalBasisMethod: "explicitRate", provisionalRate: undefined },
      { ...inventoryPolicy, shortageTreatment: "provisionalNegative", provisionalBasisMethod: "explicitRate", provisionalRate: ExactRational.zero() },
    ];
    for (const invalid of invalidInventory) expect(accountingPolicyCapabilityIsExecutable(invalid)).toBeFalse();
    for (const provisionalBasisMethod of ["lastReceiptCost", "movingAverage"] as const) {
      expect(accountingPolicyCapabilityIsExecutable({ ...inventoryPolicy, provisionalBasisMethod, provisionalRate: undefined })).toBeTrue();
    }
    const { provisionalBasisMethod: _method, provisionalRate: _rate, ...rejectInventory } = inventoryPolicy;
    expect(accountingPolicyCapabilityIsExecutable({ ...rejectInventory, shortageTreatment: "reject" })).toBeTrue();

    expect(accountingPolicyCapabilityIsExecutable({ ...basisPolicy, rules: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...basisPolicy, rules: [basisRules[0]!, { ...basisRules[1]!, event: basisRules[0]!.event }] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...basisPolicy, rules: [basisRules[0]!, { ...basisRules[1]!, id: basisRules[0]!.id }] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...monetaryPolicy, rules: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...monetaryPolicy, rules: [monetaryPolicy.rules[0]!, { ...monetaryPolicy.rules[0]!, id: policyId("other-classification-rule") }] })).toBeFalse();

    const usage: AllocationPolicy = { ...allocationPolicy, method: "unitsOfProduction", frequency: "eventDriven", convention: "usageEvent", expectedUsage: one, capability: capability("allocationSchedule", "unitsOfProduction") };
    expect(accountingPolicyCapabilityIsExecutable(usage)).toBeTrue();
    expect(accountingPolicyCapabilityIsExecutable({ ...usage, frequency: "monthly" })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...usage, convention: "fullPeriod" })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...usage, expectedUsage: undefined })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...usage, expectedUsage: ExactRational.zero() })).toBeFalse();
    for (const frequency of ["monthly", "quarterly", "annual"] as const) expect(accountingPolicyCapabilityIsExecutable({ ...allocationPolicy, frequency })).toBeTrue();
    expect(accountingPolicyCapabilityIsExecutable({ ...allocationPolicy, convention: "usageEvent" })).toBeFalse();
    const declining: AllocationPolicy = { ...allocationPolicy, method: "decliningBalance", decliningRate: one, capability: capability("allocationSchedule", "decliningBalance") };
    expect(accountingPolicyCapabilityIsExecutable(declining)).toBeTrue();
    expect(accountingPolicyCapabilityIsExecutable({ ...declining, decliningRate: undefined })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...declining, decliningRate: ExactRational.zero() })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...declining, decliningRate: ExactRational.of(2n, 1n) })).toBeFalse();

    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicy, taxCode: "" })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicy, jurisdiction: "" })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicy, components: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicy, components: [taxPolicy.components[0]!, taxPolicy.components[0]!] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicy, roundingLevel: "garbage" as unknown as TaxRoundingLevel })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicy, roundingLevel: "lineLevel" })).toBeTrue();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicy, roundingLevel: "documentLevel" })).toBeTrue();

    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicy, supportedMethods: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicy, supportedMethods: ["full", "full"] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicy, supportedMethods: ["equity"] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicy, accountMappings: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicy, translationRules: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicy, valuationPolicy: { ...consolidationPolicy.valuationPolicy, maximumHops: 0n } })).toBeFalse();

    const invalidIntervalPolicy = Object.freeze({ ...inventoryPolicy, validTo: inventoryPolicy.validFrom });
    const configured = stateWithAccounting();
    const damagedWithoutHash = { ...configured, accountingPolicySnapshot: createAccountingPolicySnapshot([invalidIntervalPolicy, ...accountingPolicies.slice(1)]) };
    const { contentHash: _oldHash, ...hashable } = damagedWithoutHash;
    const damaged = Object.freeze({ ...hashable, contentHash: hashBookState(hashable) }) as BookState;
    const result = evaluateBookCommand(damaged, createBookProtocolState(), sealCommand({ ...activationCommand("invalid-accounting-policy-interval"), bookId: IDS.book }));
    expect(result.disposition).toBe("finished");
    if (result.disposition === "finished") expect(result.result.diagnostics.some((item) => item.path.includes("accountingPolicySnapshot"))).toBeTrue();
  });

  test("projects accounting basis only from one complete canonical book snapshot", () => {
    const configured = stateWithAccounting();
    const empty = projectAccountingBasis([basisPolicy], basisPolicy.id, basisPolicy.version, createAccountingReadSnapshot(configured, instant("2026-01-15T00:00:00Z"), [], []));
    expect(empty.disposition).toBe("projected");
    if (empty.disposition === "projected") {
      expect(empty.projection.entries).toEqual([]);
      expect(empty.projection.reconciliation.sourceExactTotal.isZero()).toBeTrue();
    }
    let current = executeBookCommand(configured, createBookProtocolState(), sealCommand({ ...activationCommand("basis-snapshot-activate"), bookId: IDS.book }));
    const sourceJournal = journal("basis-snapshot-source");
    const sourceCommandId = "basis-b:basis-c";
    current = run(current, sealCommand({ ...coreCommand(current.state, sourceCommandId), type: "postJournal" as const, resolved: resolved(sourceJournal) }));
    const secondSourceJournal = journal("basis-snapshot-source:basis-b");
    const secondSourceCommandId = "basis-c";
    current = run(current, sealCommand({ ...coreCommand(current.state, secondSourceCommandId, "2026-01-15T15:00:00Z"), type: "postJournal" as const, resolved: resolved(secondSourceJournal) }));
    expect(`${sourceJournal.id}:${sourceCommandId}:journal:0`).toBe(`${secondSourceJournal.id}:${secondSourceCommandId}:journal:0`);
    const event = Object.freeze({
      id: "basis-snapshot-event",
      event: "recognition" as const,
      accountingDate: sourceJournal.accountingDate,
      source: postingReference(sourceJournal, `${sourceCommandId}:journal:0`),
      sourcePosting: sourceJournal.postings[0]!,
    });
    const secondEvent = Object.freeze({ ...event, id: "basis-snapshot-event-second", accountingDate: secondSourceJournal.accountingDate, source: postingReference(secondSourceJournal, `${secondSourceCommandId}:journal:0`), sourcePosting: secondSourceJournal.postings[0]! });
    const events = Object.freeze([secondEvent, event]);
    const at = instant("2026-01-15T16:00:00Z");
    const snapshot = createAccountingReadSnapshot(current.state, at, events.map((event) => event.source), events);
    const projected = projectAccountingBasis([basisPolicy], basisPolicy.id, basisPolicy.version, snapshot);
    expect(projected.disposition).toBe("projected");
    if (projected.disposition !== "projected") return;
    expect(projected.projection.entries[0]?.includedExactAmount.equals(ExactRational.of(100n, 1n))).toBeTrue();
    expect(projected.projection.entries[0]?.recognizedAmount?.amount.toRational().equals(ExactRational.of(100n, 1n))).toBeTrue();
    expect(projected.projection.sourceSnapshot?.throughBookRevision).toBe(current.state.bookRevision);
    expect(projected.projection.sourceSnapshot?.throughPostingSequence).toBe(current.state.latestPostingSequence);
    expect(projected.projection.sourceSnapshot?.configurationSnapshot.contentHash.digest).toBe(current.state.activeConfigurationSnapshot.contentHash.digest);
    expect(projected.projection.reconciliation.sourceExactTotal.equals(ExactRational.of(200n, 1n))).toBeTrue();
    expect(projected.projection.sourceSnapshot?.journals).toHaveLength(2);
    expect(projected.projection.sourceSnapshot?.contentHash.digest).toBe(snapshot.contentHash.digest);

    expect(projectAccountingBasis([basisPolicy], basisPolicy.id, basisPolicy.version, { ...snapshot, contentHash: hashCanonical({ damaged: true }) }).disposition).toBe("rejected");
    const amountOnlyEvent = Object.freeze({ id: "basis-amount-only", event: "recognition" as const, accountingDate: sourceJournal.accountingDate, amount: ExactRational.of(100n, 1n) });
    const amountOnlySnapshot = createAccountingReadSnapshot(current.state, at, [], [amountOnlyEvent] as never);
    expect(projectAccountingBasis([basisPolicy], basisPolicy.id, basisPolicy.version, amountOnlySnapshot).disposition).toBe("rejected");
    expect(hashAccountingReadSnapshot(snapshot).digest).toBe(snapshot.contentHash.digest);
    const mutableEvent = { ...event, id: String(event.id) };
    const copiedSnapshot = createAccountingReadSnapshot(current.state, at, [mutableEvent.source], [mutableEvent]);
    mutableEvent.id = "changed-after-snapshot";
    expect(copiedSnapshot.sourceEvents[0]!.id).toBe(event.id);
    const mutableInput = { ...copiedSnapshot, sourceEvents: [{ ...copiedSnapshot.sourceEvents[0]! }] };
    const copiedProjection = projectAccountingBasis([basisPolicy], basisPolicy.id, basisPolicy.version, mutableInput);
    expect(copiedProjection.disposition).toBe("projected");
    mutableInput.sourceEvents[0]!.id = "changed-after-projection";
    if (copiedProjection.disposition === "projected") expect(copiedProjection.projection.sourceSnapshot.sourceEvents[0]!.id).toBe(event.id);
  });

  test("derives zero, partial, and full settlement ratios from the retained allocation graph", () => {
    const ratioRule = basisRule("book-basis-ratio-recognition", "recognition", "allocateBySettlementRatio");
    const ratioPolicy: AccountingBasisPolicy = Object.freeze({ ...core("accountingBasis", "book-basis-ratio", "cash"), kind: "accountingBasis", basis: "cash", rules: Object.freeze([ratioRule]) });
    const configured = stateWithAccounting([ratioPolicy]);
    let current = executeBookCommand(configured, createBookProtocolState(), sealCommand({ ...activationCommand("basis-ratio-activate"), bookId: IDS.book }));

    const recognitionBase = journal("basis-ratio-recognition");
    const recognition = Object.freeze({ ...recognitionBase, postings: Object.freeze([Object.freeze({ ...recognitionBase.postings[0]!, accountId: A.ar }), recognitionBase.postings[1]!]) });
    const openCommandId = "basis-ratio-open-command";
    const openId = openItemId("basis-ratio-open-item");
    const open = { id: openId, bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "RATIO-CUSTOMER", controlAccountId: A.ar }, recognitionSource: postingReference(recognition, `${openCommandId}:journal:0`), recognizedOn: recognition.accountingDate, denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation };
    current = run(current, sealCommand({ ...coreCommand(current.state, openCommandId), type: "recognizeOpenItem" as const, request: { value: open }, resolved: resolved(recognition) }));

    const eventBase = Object.freeze({ id: "basis-ratio-event", event: "recognition" as const, accountingDate: recognition.accountingDate, source: postingReference(recognition, `${openCommandId}:journal:0`, 2n), sourcePosting: recognition.postings[1]!, openItemId: openId });
    const at = instant("2026-01-15T16:00:00Z");
    const project = (allocationIds: readonly ReturnType<typeof settlementAllocationId>[], eventOverrides: Record<string, unknown> = {}) => {
      const event = Object.freeze({ ...eventBase, settlementAllocationIds: Object.freeze([...allocationIds]), ...eventOverrides });
      const snapshot = createAccountingReadSnapshot(current.state, at, [event.source], [event] as never);
      return projectAccountingBasis([ratioPolicy], ratioPolicy.id, ratioPolicy.version, snapshot);
    };
    const zeroResult = project([]);
    expect(zeroResult.disposition).toBe("projected");
    if (zeroResult.disposition === "projected") expect(zeroResult.projection.entries[0]?.includedExactAmount.isZero()).toBeTrue();

    const settleHalf = (suffix: string, allocationIdValue: ReturnType<typeof settlementAllocationId>) => {
      const base = journal(`basis-ratio-settlement-${suffix}`);
      const amount = ExactDecimal.of(5_000n, 2n);
      const settlementJournal = Object.freeze({ ...base, postings: Object.freeze([
        Object.freeze({ ...base.postings[0]!, units: Object.freeze({ ...base.postings[0]!.units, canonicalNumber: ExactRational.of(50n, 1n) }), bookValue: Object.freeze({ ...base.postings[0]!.bookValue, amount }) }),
        Object.freeze({ ...base.postings[1]!, accountId: A.ar, units: Object.freeze({ ...base.postings[1]!.units, canonicalNumber: ExactRational.of(-50n, 1n) }), bookValue: Object.freeze({ ...base.postings[1]!.bookValue, amount: amount.negate() }) }),
      ]) });
      const command = `basis-ratio-settlement-${suffix}-command`;
      const settlementValue = { id: settlementId(`basis-ratio-settlement-${suffix}`), bookId: IDS.book, kind: "cash" as const, scope: open.scope, settlementSource: postingReference(settlementJournal, `${command}:journal:0`, 2n), settledAt: instant("2026-01-15T15:00:00Z"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(50n, 1n), bookValue: ExactRational.of(50n, 1n), derivation };
      current = run(current, sealCommand({ ...coreCommand(current.state, command), type: "applySettlement" as const, request: { settlement: settlementValue, allocations: [{ id: allocationIdValue, openItemId: openId, settlementId: settlementValue.id, allocatedBookValue: ExactRational.of(50n, 1n), allocatedOpenQuantity: ExactRational.of(50n, 1n), allocatedSettlementQuantity: ExactRational.of(50n, 1n), derivation }] }, resolved: [resolved(settlementJournal)] }));
    };

    const firstAllocation = settlementAllocationId("basis-ratio-allocation-first");
    settleHalf("first", firstAllocation);
    const halfResult = project([firstAllocation]);
    expect(halfResult.disposition).toBe("projected");
    if (halfResult.disposition === "projected") expect(halfResult.projection.entries[0]?.includedExactAmount.equals(ExactRational.of(-50n, 1n))).toBeTrue();

    const secondAllocation = settlementAllocationId("basis-ratio-allocation-second");
    settleHalf("second", secondAllocation);
    const fullResult = project([secondAllocation, firstAllocation]);
    expect(fullResult.disposition).toBe("projected");
    if (fullResult.disposition === "projected") expect(fullResult.projection.entries[0]?.includedExactAmount.equals(ExactRational.of(-100n, 1n))).toBeTrue();
    expect(project([firstAllocation]).disposition).toBe("rejected");
    expect(project([firstAllocation, secondAllocation], { openItemId: openItemId("missing-open-item") }).disposition).toBe("rejected");
    expect(project([firstAllocation, secondAllocation], { settlementRatio: ExactRational.of(1n, 2n) }).disposition).toBe("rejected");
    const unrelated = journal("basis-ratio-unrelated-invoice");
    const unrelatedCommand = "basis-ratio-unrelated-command";
    current = run(current, sealCommand({ ...coreCommand(current.state, unrelatedCommand), type: "postJournal" as const, resolved: resolved(unrelated) }));
    expect(project([firstAllocation, secondAllocation], {
      source: postingReference(unrelated, `${unrelatedCommand}:journal:0`, 2n),
      sourcePosting: unrelated.postings[1]!,
    }).disposition).toBe("rejected");
  });

  test("matches canonical inventory disposal selections exactly", () => {
    const allocations = Object.freeze([
      { layerId: lotHoldingId("selection-a"), quantity: one, basis: ExactRational.of(5n, 1n) },
      { layerId: lotHoldingId("selection-b"), quantity: ExactRational.of(2n, 1n), basis: ExactRational.of(10n, 1n) },
    ]);
    expect(inventoryDisposalSelectionMatches({ method: "fifo" }, "fifo", allocations)).toBeTrue();
    expect(inventoryDisposalSelectionMatches({ method: "fifo" }, "lifo", allocations)).toBeFalse();
    expect(inventoryDisposalSelectionMatches({ method: "specificIdentification", allocations: [
      { holdingId: lotHoldingId("selection-a"), quantity: one },
      { holdingId: lotHoldingId("selection-b"), quantity: ExactRational.of(2n, 1n) },
    ] }, "specificIdentification", allocations)).toBeTrue();
    expect(inventoryDisposalSelectionMatches({ method: "specificIdentification", allocations: [
      { holdingId: lotHoldingId("selection-a"), quantity: one },
    ] }, "specificIdentification", allocations)).toBeFalse();
    expect(inventoryDisposalSelectionMatches({ method: "specificIdentification", allocations: [
      { holdingId: lotHoldingId("selection-a"), quantity: one },
      { holdingId: lotHoldingId("wrong-selection"), quantity: ExactRational.of(2n, 1n) },
    ] }, "specificIdentification", allocations)).toBeFalse();
  });

  test("resolves explicit recosting populations without collapsing them into the regular period", () => {
    const adjustment = Object.freeze({ ...periods[0]!, id: "recost-adjustment" as never, kind: "adjustment" as const, sequence: 3n });
    expect(resolveRecostingPeriod([...periods, adjustment], localDate("2026-01-15"), adjustment.id)?.id).toBe(adjustment.id);
    expect(resolveRecostingPeriod([...periods, adjustment], localDate("2026-01-15"))?.id).toBe(IDS.period1);
    expect(resolveRecostingPeriod(periods, periods[0]!.startsOn)?.id).toBe(IDS.period1);
    expect(resolveRecostingPeriod(periods, periods[0]!.endsOn)?.id).toBe(IDS.period1);
  });

  test("commits all specialized capability effects through one ordered protocol and round-trips", async () => {
    const state = stateWithAccounting();
    let current = executeBookCommand(state, createBookProtocolState(), sealCommand({ ...activationCommand("accounting-activate"), bookId: IDS.book }));

    const stockLotId = lotId("book-stock-lot");
    const stockHoldingId = lotHoldingId("book-stock-holding");
    const acquisitionPostingId = postingId("book-stock-acquisition");
    const acquisition = Object.freeze({
      id: journalId("book-stock-acquisition-journal"), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-01T12:00:00Z"), accountingDate: localDate("2026-01-01"), recordedAt: instant("2026-01-01T13:00:00Z"), narration: "Acquire canonical inventory",
      postings: Object.freeze([
        Object.freeze({ id: acquisitionPostingId, ordinal: 1n, accountId: A.inventory, units: Object.freeze({ canonicalNumber: ExactRational.of(2n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(2_000n, 2n), functionalCommodityId: IDS.usd }), costBasis: Object.freeze({ totalBasis: ExactRational.of(20n, 1n), basisCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
        Object.freeze({ id: postingId("book-stock-acquisition-offset"), ordinal: 2n, accountId: A.ap, units: Object.freeze({ canonicalNumber: ExactRational.of(-20n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-2_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      ]),
    });
    current = run(current, sealCommand({ ...coreCommand(current.state, "inventory-acquisition-command", "2026-01-01T14:00:00Z"), type: "postJournal" as const, resolved: resolved(acquisition), lotOperations: [{ type: "acquire", journalPostingId: acquisitionPostingId, lot: { id: stockLotId, bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant("2026-01-01T12:00:00Z"), acquisitionQuantity: ExactRational.of(2n, 1n), acquisitionTotalBasis: ExactRational.of(20n, 1n), basisCommodityId: IDS.usd, evidenceIds: [evidence.id] }, holding: { id: stockHoldingId, bookId: IDS.book, lotId: stockLotId, accountId: A.inventory, commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: ExactRational.of(2n, 1n), remainingTotalBasis: ExactRational.of(20n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(20n, 1n) } }] }));

    const secondStockLotId = lotId("book-stock-lot-second");
    const secondStockHoldingId = lotHoldingId("book-stock-holding-second");
    const secondAcquisitionPostingId = postingId("book-stock-acquisition-second");
    const secondAcquisition = Object.freeze({
      id: journalId("book-stock-acquisition-second-journal"), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-01T12:30:00Z"), accountingDate: localDate("2026-01-01"), recordedAt: instant("2026-01-01T13:30:00Z"), narration: "Acquire second canonical inventory layer",
      postings: Object.freeze([
        Object.freeze({ id: secondAcquisitionPostingId, ordinal: 1n, accountId: A.inventory, units: Object.freeze({ canonicalNumber: one, commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(1_000n, 2n), functionalCommodityId: IDS.usd }), costBasis: Object.freeze({ totalBasis: ExactRational.of(10n, 1n), basisCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
        Object.freeze({ id: postingId("book-stock-acquisition-second-offset"), ordinal: 2n, accountId: A.ap, units: Object.freeze({ canonicalNumber: ExactRational.of(-10n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-1_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      ]),
    });
    current = run(current, sealCommand({ ...coreCommand(current.state, "inventory-acquisition-second-command", "2026-01-01T14:30:00Z"), type: "postJournal" as const, resolved: resolved(secondAcquisition), lotOperations: [{ type: "acquire", journalPostingId: secondAcquisitionPostingId, lot: { id: secondStockLotId, bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant("2026-01-01T12:30:00Z"), acquisitionQuantity: one, acquisitionTotalBasis: ExactRational.of(10n, 1n), basisCommodityId: IDS.usd, evidenceIds: [evidence.id] }, holding: { id: secondStockHoldingId, bookId: IDS.book, lotId: secondStockLotId, accountId: A.inventory, commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: one, remainingTotalBasis: ExactRational.of(10n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(10n, 1n) } }] }));

    const inventoryCommand = sealCommand({ ...coreCommand(current.state, "inventory-command"), type: "postInventoryTransaction" as const, request: { policyId: inventoryPolicy.id, policyVersion: inventoryPolicy.version, governedAt: instant("2026-01-15T14:00:00Z"), quantity: ExactRational.of(4n, 1n), layers: [
      { id: secondStockHoldingId, accountId: A.inventory, acquiredAt: instant("2026-01-01T12:30:00Z"), quantity: one, totalBasis: ExactRational.of(10n, 1n) },
      { id: stockHoldingId, accountId: A.inventory, acquiredAt: instant("2026-01-01T12:00:00Z"), quantity: ExactRational.of(2n, 1n), totalBasis: ExactRational.of(20n, 1n) },
    ] }, inventoryAccountId: A.inventory, costAccountId: A.cost, inventoryCommodityId: IDS.usd, provisionalLayerId: provisionalInventoryLayerId("book-provisional"), derivation: inventoryDerivation, lotOperations: [{ type: "dispose", holdingIds: [stockHoldingId, secondStockHoldingId], requestedQuantity: ExactRational.of(3n, 1n), selection: { method: "fifo" }, derivation: inventoryDerivation, identities: [
      { holdingId: stockHoldingId, allocationId: lotAllocationId("book-stock-allocation") },
      { holdingId: secondStockHoldingId, allocationId: lotAllocationId("book-stock-allocation-second") },
    ], journalPostingId: postingId("inventory-command-inventory") }] });
    const { provisionalLayerId: _provisionalId, ...fullyCostedCommand } = inventoryCommand;
    const fullyCosted = executeBookCommand(current.state, current.protocol, sealCommand({ ...fullyCostedCommand, request: { ...inventoryCommand.request, quantity: ExactRational.of(3n, 1n) } }));
    expect(fullyCosted.result.disposition).toBe("committed");
    expect(fullyCosted.state.accountingState.provisionalInventoryLayers).toHaveLength(0);
    expect(fullyCosted.state.journals.at(-1)!.journal.postings.map(p => p.bookValue.amount.toRational().toString())).toEqual(["30/1", "-30/1"]);
    current = run(current, inventoryCommand);
    expect(current.state.accountingState.provisionalInventoryLayers).toHaveLength(1);
    const malformedProvisionalRevisions = current.state.revisions.map((revision) => revision.command.id === inventoryCommand.id
      ? { ...revision, effects: revision.effects.map((effect) => effect.type === "provisionalInventoryLayer" ? { ...effect, value: { ...effect.value, issueSource: undefined } } : effect) }
      : revision);
    const malformedProvisionalState = { ...current.state, revisions: malformedProvisionalRevisions } as BookState;
    expect(validateBookState(malformedProvisionalState).some((item) => item.code === "unresolved_accounting_input")).toBeTrue();

    current = run(current, sealCommand({ ...coreCommand(current.state, "inventory-all-provisional-command", "2026-01-16T14:00:00Z"), type: "postInventoryTransaction" as const, request: { policyId: inventoryPolicy.id, policyVersion: inventoryPolicy.version, governedAt: instant("2026-01-16T14:00:00Z"), quantity: one, layers: [] }, inventoryAccountId: A.inventory, costAccountId: A.cost, inventoryCommodityId: IDS.usd, provisionalLayerId: provisionalInventoryLayerId("book-provisional-all"), derivation: inventoryDerivation }));
    expect(current.state.accountingState.provisionalInventoryLayers).toHaveLength(2);

    current = run(current, sealCommand({ ...coreCommand(current.state, "recost-command", "2026-01-20T14:00:00Z"), type: "recostProvisionalInventory" as const, fiscalPeriodId: IDS.period1, request: { id: inventoryRecostingId("book-recost"), layerId: provisionalInventoryLayerId("book-provisional"), resolvedAt: instant("2026-01-01T14:00:00Z"), sources: [{ receiptId: "receipt", quantity: one, totalBasis: ExactRational.of(9n, 1n) }], derivation: inventoryDerivation }, inventoryAccountId: A.inventory, adjustmentAccountId: A.adjustment }));
    const recognitionBase = journal("open-item-journal");
    const recognition = Object.freeze({ ...recognitionBase, postings: Object.freeze([Object.freeze({ ...recognitionBase.postings[0]!, accountId: A.ar }), recognitionBase.postings[1]!]) });
    const open = { id: openItemId("book-open"), bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "CUSTOMER", controlAccountId: A.ar }, recognitionSource: postingReference(recognition, "open-command:journal:0"), recognizedOn: recognition.accountingDate, denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation };
    current = run(current, sealCommand({ ...coreCommand(current.state, "open-command", "2026-01-21T14:00:00Z"), type: "recognizeOpenItem" as const, request: { value: open }, resolved: resolved(recognition) }));

    const settlementJournalBase = journal("settlement-journal");
    const settlementJournal = Object.freeze({ ...settlementJournalBase, postings: Object.freeze(settlementJournalBase.postings.map((p, i) => Object.freeze({ ...p, accountId: i === 0 ? A.ar : IDS.cash, units: Object.freeze({ ...p.units, canonicalNumber: p.units.canonicalNumber.negate() }), bookValue: Object.freeze({ ...p.bookValue, amount: ExactDecimal.of(-p.bookValue.amount.coefficient, p.bookValue.amount.scale) }) }))) });
    const settlement = { id: settlementId("book-settlement"), bookId: IDS.book, kind: "cash" as const, scope: open.scope, settlementSource: postingReference(settlementJournal, "settlement-command:journal:0"), settledAt: instant("2026-01-15T14:00:00Z"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation };
    const duplicateIdJournalBase = journal("settlement-duplicate-id-content");
    const duplicateIdJournal = Object.freeze({ ...duplicateIdJournalBase, id: settlementJournal.id });
    const duplicateJournalSettlement = sealCommand({ ...coreCommand(current.state, "settlement-duplicate-journal-command", "2026-01-22T13:00:00Z"), type: "applySettlement" as const, request: { settlement: { ...settlement, id: settlementId("book-settlement-duplicate-journal"), settlementSource: postingReference(settlementJournal, "settlement-duplicate-journal-command:journal:0") }, allocations: [{ id: settlementAllocationId("book-edge-duplicate-journal"), openItemId: open.id, settlementId: settlementId("book-settlement-duplicate-journal"), allocatedBookValue: ExactRational.of(100n, 1n), allocatedOpenQuantity: ExactRational.of(100n, 1n), allocatedSettlementQuantity: ExactRational.of(100n, 1n), derivation }] }, resolved: [resolved(settlementJournal), resolved(duplicateIdJournal)] });
    expect(executeBookCommand(current.state, current.protocol, duplicateJournalSettlement).result.disposition).toBe("rejected");
    const zeroKeySettlementId = settlementId("book-settlement-zero-key");
    const zeroKeyCommand = sealCommand({ ...coreCommand(current.state, "settlement-zero-key-command", "2026-01-22T13:30:00Z"), type: "applySettlement" as const, request: { settlement: { ...settlement, id: zeroKeySettlementId, settlementSource: postingReference(settlementJournal, "settlement-zero-key-command:journal:0") }, allocations: [{ id: settlementAllocationId("book-edge-zero-key"), openItemId: open.id, settlementId: zeroKeySettlementId, allocatedBookValue: ExactRational.of(100n, 1n), allocatedOpenQuantity: ExactRational.of(100n, 1n), allocatedSettlementQuantity: ExactRational.of(100n, 1n), realizedExchangeEffectKey: "settlement-zero-key-command:journal:1" as never, derivation }] }, resolved: [resolved(settlementJournal)] });
    expect(executeBookCommand(current.state, current.protocol, zeroKeyCommand).result.diagnostics[0]?.code).toBe("settlement_allocation_violation");
    current = run(current, sealCommand({ ...coreCommand(current.state, "settlement-command", "2026-01-22T14:00:00Z"), type: "applySettlement" as const, request: { settlement, allocations: [{ id: settlementAllocationId("book-edge"), openItemId: open.id, settlementId: settlement.id, allocatedBookValue: ExactRational.of(50n, 1n), allocatedOpenQuantity: ExactRational.of(50n, 1n), allocatedSettlementQuantity: ExactRational.of(50n, 1n), derivation }] }, resolved: [resolved(settlementJournal)] }));
    const malformedSettlementRevisions = current.state.revisions.map((revision) => revision.command.id === commandId("settlement-command")
      ? { ...revision, effects: revision.effects.map((effect) => effect.type === "settlement" ? { ...effect, value: { ...effect.value, settlementSource: undefined } } : effect) }
      : revision);
    expect(validateBookState({ ...current.state, revisions: malformedSettlementRevisions } as BookState).some((item) => item.code === "unresolved_accounting_input")).toBeTrue();

    current = run(current, sealCommand({ ...coreCommand(current.state, "recost-endpoint-command", "2026-01-31T13:00:00Z"), type: "recostProvisionalInventory" as const, fiscalPeriodId: IDS.period1, request: { id: inventoryRecostingId("book-recost-endpoint"), layerId: provisionalInventoryLayerId("book-provisional-all"), resolvedAt: instant("2026-01-31T13:00:00Z"), sources: [{ receiptId: "receipt-endpoint", quantity: one, totalBasis: ExactRational.of(7n, 1n) }], derivation: inventoryDerivation }, inventoryAccountId: A.inventory, adjustmentAccountId: A.adjustment }));
    const beforeFx = current;
    const fxCommand = sealCommand({ ...coreCommand(current.state, "fx-command", "2026-01-31T14:00:00Z"), type: "postCurrencyRemeasurement" as const, request: { id: remeasurementResultId("book-fx"), policyId: currencyPolicy.id, policyVersion: currencyPolicy.version, classificationPolicyId: monetaryPolicy.id, classificationPolicyVersion: monetaryPolicy.version, governedAt: instant("2026-01-31T14:00:00Z"), kind: "unrealized" as const, classification: "monetary" as const, source: open.recognitionSource, generatedEffectKey: "fx-command:journal:0" as never, effectiveOn: localDate("2026-01-31"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(50n, 1n), carryingBookValue: ExactRational.of(50n, 1n), valuationPath: { fromCommodityId: IDS.usd, toCommodityId: IDS.usd, effectiveAt: instant("2026-01-31T14:00:00Z"), observedAt: instant("2026-01-31T13:00:00Z"), rate: ExactRational.of(11n, 10n), evidenceIds: [evidence.id] }, positionAccountId: A.ar, derivation } });
    const wrongFxKey = executeBookCommand(beforeFx.state, beforeFx.protocol, sealCommand({ ...fxCommand, request: { ...fxCommand.request, generatedEffectKey: "wrong-key" as never } }));
    expect(wrongFxKey.result.diagnostics[0]?.path).toBe("command.request.generatedEffectKey");
    current = run(current, fxCommand);
    const malformedRemeasurementRevisions = current.state.revisions.map((revision) => revision.command.id === commandId("fx-command")
      ? { ...revision, effects: revision.effects.map((effect) => effect.type === "remeasurementResult" ? { ...effect, value: { ...effect.value, source: undefined } } : effect) }
      : revision);
    expect(validateBookState({ ...current.state, revisions: malformedRemeasurementRevisions } as BookState).some((item) => item.code === "unresolved_accounting_input")).toBeTrue();
    for (const patch of [
      { classificationPolicy: { ...monetaryPolicy, rules: [classificationRule("nonmonetary-tamper", "ar", "nonMonetary")] } },
      { positionAccountId: A.gain, classificationPolicy: { ...monetaryPolicy, rules: [classificationRule("other-position-tamper", "gain", "monetary")] } },
      { denominationCommodityId: "wrong-denomination" as never },
    ]) {
      const revisions = current.state.revisions.map(revision => revision.command.id !== commandId("fx-command") ? revision : { ...revision, effects: revision.effects.map(effect => effect.type !== "remeasurementResult" ? effect : { ...effect, value: { ...effect.value, ...patch } }) });
      // Require the source-closure diagnostic specifically; hash damage alone is not evidence for this contract.
      expect(validateBookState({ ...current.state, revisions }).some(d => d.code === "unresolved_accounting_input" && d.message.startsWith("Currency remeasurement"))).toBeTrue();
    }
    const alteredRemeasurementState = Object.freeze({ ...current.state, accountingState: Object.freeze({ ...current.state.accountingState, remeasurementResults: Object.freeze(current.state.accountingState.remeasurementResults.map((result) => result.id === remeasurementResultId("book-fx") ? Object.freeze({ ...result, difference: ExactRational.of(15n, 1n) }) : result)) }) });
    const alteredRemeasurementStateWithHash = Object.freeze({ ...alteredRemeasurementState, contentHash: hashBookState(alteredRemeasurementState) }) as BookState;
    const malformedReversal = sealCommand({ ...coreCommand(alteredRemeasurementStateWithHash, "fx-malformed-reversal", "2026-02-01T12:00:00Z"), type: "postCurrencyRemeasurement" as const, request: { id: remeasurementResultId("book-fx-malformed-reversal"), policyId: currencyPolicy.id, policyVersion: currencyPolicy.version, classificationPolicyId: monetaryPolicy.id, classificationPolicyVersion: monetaryPolicy.version, governedAt: instant("2026-02-01T12:00:00Z"), kind: "unrealized" as const, classification: "monetary" as const, source: open.recognitionSource, generatedEffectKey: "fx-malformed-reversal:journal:0" as never, effectiveOn: localDate("2026-02-01"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), carryingBookValue: ExactRational.of(100n, 1n), valuationPath: { fromCommodityId: IDS.usd, toCommodityId: IDS.usd, effectiveAt: instant("2026-02-01T12:00:00Z"), observedAt: instant("2026-02-01T11:00:00Z"), rate: ExactRational.of(11n, 10n), evidenceIds: [evidence.id] }, positionAccountId: A.ar, reversalOf: remeasurementResultId("book-fx"), reversalId: remeasurementReversalId("book-fx-malformed-reversal"), derivation } });
    expect(executeBookCommand(alteredRemeasurementStateWithHash, current.protocol, malformedReversal).result.diagnostics[0]?.code).toBe("currency_remeasurement_violation");
    const wrongOriginalKey = { ...current.state, accountingState: { ...current.state.accountingState, remeasurementResults: current.state.accountingState.remeasurementResults.map(result => ({ ...result, adjustmentEffectKey: "wrong-original-key" as never })) } };
    const wrongOriginalKeyState = { ...wrongOriginalKey, contentHash: hashBookState(wrongOriginalKey) };
    const wrongKeyReversal = executeBookCommand(wrongOriginalKeyState, current.protocol, malformedReversal);
    expect(wrongKeyReversal.result.disposition).toBe("rejected");
    expect(wrongKeyReversal.result.diagnostics[0]?.path).toBe("command.request.reversalOf");
    current = run(current, sealCommand({ ...coreCommand(current.state, "fx-same-day-schedule", "2026-01-31T15:00:00Z"), type: "createAllocationSchedule" as const, request: { id: allocationScheduleId("fx-same-day-schedule"), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, governedAt: instant("2026-01-31T15:00:00Z"), source: open.recognitionSource, sourceBasis: ExactRational.of(100n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-31"), derivation } }));
    current = run(current, sealCommand({ ...coreCommand(current.state, "fx-reversal-command", "2026-02-01T13:00:00Z"), type: "postCurrencyRemeasurement" as const, request: { id: remeasurementResultId("book-fx-reversal-placeholder"), policyId: currencyPolicy.id, policyVersion: currencyPolicy.version, classificationPolicyId: monetaryPolicy.id, classificationPolicyVersion: monetaryPolicy.version, governedAt: instant("2026-02-01T13:00:00Z"), kind: "unrealized", classification: "monetary", source: open.recognitionSource, generatedEffectKey: "fx-reversal-command:journal:0" as never, effectiveOn: localDate("2026-02-01"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), carryingBookValue: ExactRational.of(100n, 1n), valuationPath: { fromCommodityId: IDS.usd, toCommodityId: IDS.usd, effectiveAt: instant("2026-02-01T13:00:00Z"), observedAt: instant("2026-02-01T12:00:00Z"), rate: ExactRational.of(11n, 10n), evidenceIds: [evidence.id] }, positionAccountId: A.ar, reversalOf: remeasurementResultId("book-fx"), reversalId: remeasurementReversalId("book-fx-reversal"), derivation } }));

    const scheduleId = allocationScheduleId("book-schedule");
    current = run(current, sealCommand({ ...coreCommand(current.state, "schedule-command", "2026-02-02T14:00:00Z"), type: "createAllocationSchedule" as const, request: { id: scheduleId, policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, governedAt: instant("2026-01-15T14:00:00Z"), source: open.recognitionSource, sourceBasis: ExactRational.of(100n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-02-28"), derivation } }));
    const beforeRecognitionSequence = current.state.latestPostingSequence;
    current = run(current, sealCommand({ ...coreCommand(current.state, "allocation-command", "2026-02-03T14:00:00Z"), type: "recognizeScheduledAllocation" as const, request: { id: allocationRecognitionId("book-allocation"), scheduleId, ordinal: 1n, governedAt: instant("2026-01-31T14:00:00Z"), derivation } }));
    expect(current.state.latestPostingSequence).toBe(beforeRecognitionSequence + 1n);

    current = run(current, sealCommand({ ...coreCommand(current.state, "tax-command", "2026-02-04T14:00:00Z"), type: "postTaxedTransaction" as const, request: { id: taxDeterminationId("book-tax-determination"), sourceTransactionId: journalId("book-tax-source"), governedAt: instant("2026-01-15T14:00:00Z"), direction: "purchase", lines: [{ lineId: "book-tax-line", sourcePostingId: postingId("book-tax-source-posting"), counterpartyPostingId: postingId("book-tax-counterparty-posting"), policyId: taxPolicy.id, policyVersion: taxPolicy.version, statedAmount: ExactRational.of(100n, 1n), amountIncludesTax: false, sourceAccountId: A.cost, payableAccountId: A.ap }], derivation } }));

    const sourcePopulationHash = hashCanonical({ source: "book" });
    const consolidationDerivation = Object.freeze({ ...derivation, policyId: consolidationPolicy.id, policyVersion: consolidationPolicy.version });
    current = run(current, sealCommand({ ...coreCommand(current.state, "consolidation-command", "2026-02-05T14:00:00Z"), type: "compileConsolidation" as const, request: { id: consolidationCompilationId("book-compilation"), policyId: consolidationPolicy.id, policyVersion: consolidationPolicy.version, governedAt: instant("2026-01-31T15:00:00Z"), throughOn: localDate("2026-01-31"), targetBookId: IDS.book, sources: [{ bookId: "source-book" as never, revision: 1n, postingSequence: 1n, populationHash: sourcePopulationHash, expectedRevision: 1n, expectedPostingSequence: 1n, expectedPopulationHash: sourcePopulationHash, relationshipId: "book-source-control", relationshipValidFrom: instant("2020-01-01T00:00:00Z"), control: "controlled", method: "full", ownershipShare: one, votingShare: one, controlEvidenceIds: ["control"], balances: [
        { sourceAccountId: A.target, unitsCommodityId: IDS.usd, classification: "asset", amount: ExactRational.of(1n, 3n), valuationPaths: [] },
        { sourceAccountId: A.inventory, unitsCommodityId: IDS.usd, classification: "equity", amount: ExactRational.of(-1n, 3n), valuationPaths: [] },
      ] }], eliminations: [], derivation: consolidationDerivation } }));

    expect(current.state.accountingState.inventoryRecostings).toHaveLength(2);
    expect(current.state.accountingState.openItems).toHaveLength(1);
    expect(current.state.accountingState.settlementAllocations).toHaveLength(1);
    expect(current.state.accountingState.remeasurementResults).toHaveLength(1);
    expect(current.state.accountingState.remeasurementReversals).toHaveLength(1);
    expect(current.state.accountingState.remeasurementReversals[0]!.originalEffectKey).toBe("fx-command:journal:0" as never);
    expect(current.state.accountingState.allocationRecognitions).toHaveLength(1);
    expect(current.state.accountingState.taxDeterminations).toHaveLength(1);
    expect(current.state.accountingState.consolidationCompilations).toHaveLength(1);
    expect(current.state.journals.at(-1)?.journal.postings.reduce((total, posting) => total.add(posting.bookValue.amount.toRational()), ExactRational.zero()).isZero()).toBeTrue();
    expect(current.state.revisions.map((revision) => commandInputHash(revision.command).digest === revision.command.inputHash.digest)).toEqual(current.state.revisions.map(() => true));
    expect(validateBookState(current.state)).toEqual([]);
    const decoded = decodeDurableBook(encodeDurableBook({ state: current.state, protocol: current.protocol }));
    if (decoded.disposition === "rejected") throw new Error(decoded.message);
    expect(decoded.disposition).toBe("decoded");
    expect(executeBookCommand(current.state, current.protocol, inventoryCommand).result.disposition).toBe("replayed");

    const missingDerived = { ...current.state, accountingState: { ...current.state.accountingState, consolidationCompilations: [] } } as BookState;
    expect(validateBookState(missingDerived).some((item) => item.path === "state.accountingState")).toBeTrue();

    const golden = (await Bun.file("packages/kernel/spec/golden-company.json").json()) as {
      readonly accounting_kernel_extension: {
        readonly configuration_revision: number;
        readonly policy_families: readonly string[];
        readonly command_kinds: readonly string[];
        readonly immutable_effect_families: readonly string[];
        readonly durable_round_trip: boolean;
        readonly replay_stable: boolean;
        readonly derived_lifecycle_rebuilt_from_effects: boolean;
      };
    };
    const extension = golden.accounting_kernel_extension;
    expect(extension.configuration_revision).toBe(1);
    const observedPolicyFamilies: string[] = current.state.accountingPolicySnapshot.policies.map((item) => item.kind);
    expect([...new Set(observedPolicyFamilies)].sort()).toEqual([...extension.policy_families].sort());
    const observedCommandKinds: string[] = current.state.revisions.map((item) => item.command.type);
    expect([...new Set(observedCommandKinds.filter((type) => extension.command_kinds.includes(type)))].sort()).toEqual([...extension.command_kinds].sort());
    const observedEffectKinds: string[] = current.state.revisions.flatMap((revision) => revision.effects.map((effect) => effect.type));
    const accountingEffectKinds = observedEffectKinds.filter((type) => extension.immutable_effect_families.includes(type));
    expect([...new Set(accountingEffectKinds)].sort()).toEqual([...extension.immutable_effect_families].sort());
    expect(extension.durable_round_trip).toBeTrue();
    expect(extension.replay_stable).toBeTrue();
    expect(extension.derived_lifecycle_rebuilt_from_effects).toBeTrue();
  });

  test("commits inventory value adjustments, prospective schedule revisions, and cross-currency settlement effects", () => {
    const configured = stateWithAccounting([inventoryValuePolicy]);
    let current = executeBookCommand(configured, createBookProtocolState(), sealCommand({ ...activationCommand("enterprise-specialized-activate"), bookId: IDS.book }));

    const acquisitionBase = journal("enterprise-value-acquisition");
    const acquisition = Object.freeze({
      ...acquisitionBase,
      postings: Object.freeze([
        Object.freeze({ ...acquisitionBase.postings[0]!, accountId: A.inventory, units: Object.freeze({ canonicalNumber: ExactRational.of(2n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(2_000n, 2n), functionalCommodityId: IDS.usd }), costBasis: Object.freeze({ totalBasis: ExactRational.of(20n, 1n), basisCommodityId: IDS.usd }) }),
        Object.freeze({ ...acquisitionBase.postings[1]!, accountId: A.ap, units: Object.freeze({ canonicalNumber: ExactRational.of(-2n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-2_000n, 2n), functionalCommodityId: IDS.usd }) }),
      ]),
    });
    const valueLotId = lotId("enterprise-value-lot");
    const valueHoldingId = lotHoldingId("enterprise-value-holding");
    current = run(current, sealCommand({ ...coreCommand(current.state, "enterprise-value-acquisition-command", "2026-01-01T14:00:00Z"), type: "postJournal" as const, resolved: resolved(acquisition), lotOperations: [{ type: "acquire", journalPostingId: acquisition.postings[0]!.id, lot: { id: valueLotId, bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant("2026-01-01T12:00:00Z"), acquisitionQuantity: ExactRational.of(2n, 1n), acquisitionTotalBasis: ExactRational.of(20n, 1n), basisCommodityId: IDS.usd, evidenceIds: [evidence.id] }, holding: { id: valueHoldingId, bookId: IDS.book, lotId: valueLotId, accountId: A.inventory, commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: ExactRational.of(2n, 1n), remainingTotalBasis: ExactRational.of(20n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(20n, 1n) } }] }));
    const adjustmentCommand = sealCommand({ ...coreCommand(current.state, "enterprise-value-adjustment-command"), type: "adjustInventoryValue" as const, fiscalPeriodId: IDS.period1, generatedPostingDimensionSelections: [
      { effectKey: "enterprise-value-adjustment-command:journal:0" as never, postingOrdinal: 2n, dimensionMemberIds: [] },
      { effectKey: "enterprise-value-adjustment-command:journal:0" as never, postingOrdinal: 1n, dimensionMemberIds: [] },
    ], request: { id: inventoryValueAdjustmentId("enterprise-value-adjustment"), kind: "directlyAttributableCost" as const, effectiveOn: localDate("2026-01-15"), policyEffectiveAt: instant("2026-01-15T14:00:00Z"), policyId: inventoryValuePolicy.id, policyVersion: inventoryValuePolicy.version, generatedEffectKey: "enterprise-value-adjustment-command:journal:0" as never, exactSourceAmount: ExactRational.of(5n, 1n), allocations: [{ ordinal: 1n, lotId: valueLotId, holdingId: valueHoldingId, remainingBasisChange: ExactRational.of(5n, 1n), recognizedCostChange: ExactRational.zero(), remainingValuationAllowanceChange: ExactRational.zero() }], evidence: evidence ? [evidence] : [], derivation: Object.freeze({ ...derivation, policyId: inventoryValuePolicy.id, policyVersion: inventoryValuePolicy.version }) } });
    const invalidAdjustmentLineage = sealCommand({ ...coreCommand(current.state, "enterprise-invalid-adjustment-lineage"), type: "adjustInventoryValue" as const, fiscalPeriodId: IDS.period1, request: { ...adjustmentCommand.request, id: inventoryValueAdjustmentId("enterprise-invalid-adjustment-lineage"), generatedEffectKey: "not-this-command:journal:0" as never } });
    expect(executeBookCommand(current.state, current.protocol, invalidAdjustmentLineage).result.diagnostics[0]?.code).toBe("inventory_value_adjustment_violation");
    const duplicateDimensionCommand = sealCommand({ ...coreCommand(current.state, "enterprise-duplicate-generated-dimensions"), type: "adjustInventoryValue" as const, fiscalPeriodId: IDS.period1, generatedPostingDimensionSelections: [
      { effectKey: "enterprise-duplicate-generated-dimensions:journal:0" as never, postingOrdinal: 1n, dimensionMemberIds: [] },
      { effectKey: "enterprise-duplicate-generated-dimensions:journal:0" as never, postingOrdinal: 1n, dimensionMemberIds: [] },
    ], request: { ...adjustmentCommand.request, id: inventoryValueAdjustmentId("enterprise-duplicate-generated-dimensions"), generatedEffectKey: "enterprise-duplicate-generated-dimensions:journal:0" as never } });
    expect(executeBookCommand(current.state, current.protocol, duplicateDimensionCommand).result.diagnostics[0]?.code).toBe("invalid_dimension_selection");
    const unusedDimensionCommand = sealCommand({ ...coreCommand(current.state, "enterprise-unused-generated-dimensions"), type: "adjustInventoryValue" as const, fiscalPeriodId: IDS.period1, generatedPostingDimensionSelections: [
      { effectKey: "unused-effect:journal:0" as never, postingOrdinal: 1n, dimensionMemberIds: [] },
    ], request: { ...adjustmentCommand.request, id: inventoryValueAdjustmentId("enterprise-unused-generated-dimensions"), generatedEffectKey: "enterprise-unused-generated-dimensions:journal:0" as never } });
    expect(executeBookCommand(current.state, current.protocol, unusedDimensionCommand).result.diagnostics[0]?.code).toBe("invalid_dimension_selection");
    current = run(current, adjustmentCommand);
    expect(current.state.accountingState.inventoryValueAdjustments).toHaveLength(1);
    expect(current.state.lotHoldings.find((holding) => holding.id === valueHoldingId)?.remainingTotalBasis.equals(ExactRational.of(25n, 1n))).toBeTrue();
    const changedQuantity = { ...current.state, lotHoldings: current.state.lotHoldings.map(h => ({ ...h, remainingQuantity: h.remainingQuantity.add(one) })) };
    expect(hashBookState(changedQuantity).digest).not.toBe(hashBookState(current.state).digest);
    const valueAdjustmentJournal = current.state.journals.find((booked) => booked.journal.id === `${adjustmentCommand.request.id}-journal`);
    expect(valueAdjustmentJournal?.effectKey).toBe(adjustmentCommand.request.generatedEffectKey);

    const sourceJournalBase = journal("enterprise-schedule-source");
    const sourceJournal = Object.freeze({ ...sourceJournalBase, postings: Object.freeze([Object.freeze({ ...sourceJournalBase.postings[0]!, accountId: A.ar }), sourceJournalBase.postings[1]!]) });
    const sourceCommand = sealCommand({ ...coreCommand(current.state, "enterprise-schedule-source-command"), type: "postJournal" as const, resolved: resolved(sourceJournal) });
    current = run(current, sourceCommand);
    const source = postingReference(sourceJournal, "enterprise-schedule-source-command:journal:0");
    const scheduleId = allocationScheduleId("enterprise-schedule-original");
    current = run(current, sealCommand({ ...coreCommand(current.state, "enterprise-schedule-create-command"), type: "createAllocationSchedule" as const, request: { id: scheduleId, policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, governedAt: instant("2026-01-15T15:00:00Z"), source, sourceBasis: ExactRational.of(100n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-03-31"), derivation } }));
    const scheduleDerivation = Object.freeze({ ...derivation, policyId: allocationPolicy.id, policyVersion: allocationPolicy.version });
    current = run(current, sealCommand({ ...coreCommand(current.state, "enterprise-schedule-recognition-command"), type: "recognizeScheduledAllocation" as const, request: { id: allocationRecognitionId("enterprise-schedule-recognition"), scheduleId, ordinal: 1n, governedAt: instant("2026-01-31T15:00:00Z"), derivation: scheduleDerivation } }));
    const revisionCommand = sealCommand({ ...coreCommand(current.state, "enterprise-schedule-revision-command"), type: "reviseAllocationSchedule" as const, request: { id: allocationScheduleRevisionId("enterprise-schedule-revision"), kind: "estimateChange" as const, effectiveOn: localDate("2026-02-01"), policyEffectiveAt: instant("2026-02-01T15:00:00Z"), originalScheduleId: scheduleId, priorRecognitionIds: [allocationRecognitionId("enterprise-schedule-recognition")], policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, revisedResidualValue: ExactRational.zero(), successorScheduleId: allocationScheduleId("enterprise-schedule-successor"), revisedEndsOn: localDate("2026-03-31"), evidence: scheduleDerivation.evidence, derivation: scheduleDerivation } });
    const revisionEvaluation = evaluateBookCommand(current.state, current.protocol, revisionCommand);
    expect(revisionEvaluation.disposition).toBe("ready");
    if (revisionEvaluation.disposition === "ready") expect(validateBookEffectTopology(current.state, revisionEvaluation.intent)).toEqual([]);
    current = run(current, revisionCommand);
    expect(current.state.accountingState.allocationScheduleRevisions).toHaveLength(1);
    expect(current.state.accountingState.allocationSchedules.some((schedule) => schedule.id === revisionCommand.request.successorScheduleId)).toBeTrue();
    expect(executeBookCommand(current.state, current.protocol, revisionCommand).result.disposition).toBe("replayed");
    expect(executeBookCommand(current.state, current.protocol, sealCommand({ ...coreCommand(current.state, "enterprise-old-recognition-command"), type: "recognizeScheduledAllocation" as const, request: { id: allocationRecognitionId("enterprise-old-recognition"), scheduleId, ordinal: 2n, governedAt: instant("2026-02-28T15:00:00Z"), derivation: scheduleDerivation } })).result.disposition).toBe("rejected");

    const foreignCommodity = "commodity-EUR" as never;
    const openJournalBase = journal("enterprise-fx-open-source");
    const openJournal = Object.freeze({ ...openJournalBase, postings: Object.freeze([Object.freeze({ ...openJournalBase.postings[0]!, accountId: A.ar, units: Object.freeze({ canonicalNumber: ExactRational.of(100n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(10_000n, 2n), functionalCommodityId: IDS.usd }) }), Object.freeze({ ...openJournalBase.postings[1]!, accountId: A.gain, units: Object.freeze({ canonicalNumber: ExactRational.of(-100n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-10_000n, 2n), functionalCommodityId: IDS.usd }) })]) });
    const openSource = postingReference(openJournal, "enterprise-fx-recognize-command:journal:0");
    const openId = openItemId("enterprise-fx-open");
    const openValue = { id: openId, bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "FX-CUSTOMER", controlAccountId: A.ar }, recognitionSource: openSource, recognizedOn: localDate("2026-01-15"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation };
    current = run(current, sealCommand({ ...coreCommand(current.state, "enterprise-fx-recognize-command"), type: "recognizeOpenItem" as const, request: { value: openValue }, resolved: resolved(openJournal) }));
    const settlementJournalBase = journal("enterprise-fx-settlement-source", "2026-01-31");
    const settlementJournal = Object.freeze({ ...settlementJournalBase, postings: Object.freeze([Object.freeze({ ...settlementJournalBase.postings[0]!, accountId: A.ar, units: Object.freeze({ canonicalNumber: ExactRational.of(-100n, 1n), commodityId: foreignCommodity }), bookValue: Object.freeze({ amount: ExactDecimal.of(-12_000n, 2n), functionalCommodityId: IDS.usd }) }), Object.freeze({ ...settlementJournalBase.postings[1]!, accountId: IDS.cash, units: Object.freeze({ canonicalNumber: ExactRational.of(100n, 1n), commodityId: foreignCommodity }), bookValue: Object.freeze({ amount: ExactDecimal.of(12_000n, 2n), functionalCommodityId: IDS.usd }) })]) });
    const settlementSource = postingReference(settlementJournal, "enterprise-fx-settlement-command:journal:0");
    const settlementIdValue = settlementId("enterprise-fx-settlement");
    const settlement = { id: settlementIdValue, bookId: IDS.book, kind: "cash" as const, scope: openValue.scope, settlementSource, settledAt: instant("2026-01-31T14:00:00Z"), denominationCommodityId: foreignCommodity, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(120n, 1n), derivation };
    const fxSettlementCommand = sealCommand({ ...coreCommand(current.state, "enterprise-fx-settlement-command"), type: "applySettlement" as const, request: { settlement, realizedExchangePolicyId: currencyPolicy.id, realizedExchangePolicyVersion: currencyPolicy.version, allocations: [{ id: settlementAllocationId("enterprise-fx-edge"), openItemId: openId, settlementId: settlementIdValue, allocatedBookValue: ExactRational.of(100n, 1n), allocatedOpenItemBookValue: ExactRational.of(100n, 1n), allocatedSettlementBookValue: ExactRational.of(120n, 1n), allocatedOpenQuantity: ExactRational.of(100n, 1n), allocatedSettlementQuantity: ExactRational.of(100n, 1n), valuationPath: { fromCommodityId: foreignCommodity, toCommodityId: IDS.usd, effectiveAt: instant("2026-01-31T14:00:00Z"), observedAt: instant("2026-01-31T13:00:00Z"), rate: ExactRational.of(6n, 5n), evidenceIds: [evidence.id] }, realizedExchangeEffectKey: "enterprise-fx-settlement-command:journal:1" as never, derivation }] }, resolved: [resolved(settlementJournal)] });
    current = run(current, fxSettlementCommand);
    expect(current.state.accountingState.settlementAllocations[0]?.realizedExchangeDifference?.amount.toRational().equals(ExactRational.of(20n, 1n))).toBeTrue();
    expect(current.state.journals.some((booked) => booked.effectKey === "enterprise-fx-settlement-command:journal:1")).toBeTrue();
    expect(validateBookState(current.state)).toEqual([]);
    const decoded = decodeDurableBook(encodeDurableBook({ state: current.state, protocol: current.protocol }));
    expect(decoded.disposition).toBe("decoded");
  });

  test("serializes competing specialized intents against the same book revision", () => {
    const configured = stateWithAccounting();
    const activated = executeBookCommand(configured, createBookProtocolState(), sealCommand({ ...activationCommand("competing-accounting-activate"), bookId: IDS.book }));
    const sourceJournal = journal("competing-source");
    const active = executeBookCommand(activated.state, activated.protocol, sealCommand({ ...coreCommand(activated.state, "competing-source-command"), type: "postJournal" as const, resolved: resolved(sourceJournal) }));
    const source = postingReference(sourceJournal, "competing-source-command:journal:0");
    const left = sealCommand({ ...coreCommand(active.state, "competing-left"), type: "createAllocationSchedule" as const, request: { id: allocationScheduleId("competing-left-schedule"), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, governedAt: instant("2026-01-15T14:00:00Z"), source, sourceBasis: ExactRational.of(100n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-31"), derivation } });
    const right = sealCommand({ ...coreCommand(active.state, "competing-right"), type: "createAllocationSchedule" as const, request: { id: allocationScheduleId("competing-right-schedule"), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, governedAt: instant("2026-01-15T14:00:00Z"), source, sourceBasis: ExactRational.of(100n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-31"), derivation } });
    const leftEvaluation = evaluateBookCommand(active.state, active.protocol, left);
    const rightEvaluation = evaluateBookCommand(active.state, active.protocol, right);
    expect(leftEvaluation.disposition).toBe("ready");
    expect(rightEvaluation.disposition).toBe("ready");
    const missingSource = sealCommand({ ...coreCommand(active.state, "competing-missing-source"), type: "createAllocationSchedule" as const, request: { id: allocationScheduleId("competing-missing-source-schedule"), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, governedAt: instant("2026-01-15T14:00:00Z"), sourceBasis: ExactRational.of(100n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-31"), derivation } });
    const missingSourceResult = executeBookCommand(active.state, active.protocol, missingSource).result;
    expect(missingSourceResult.disposition).toBe("rejected");
    expect(missingSourceResult.diagnostics.some((item) => item.code === "unresolved_accounting_input")).toBeTrue();
    const damagedPostingHash = hashCanonical({ damaged: "source-posting" });
    const damagedSource = Object.freeze({ ...source, postingContentHash: damagedPostingHash, contentHash: hashCanonical({ id: source.id, bookId: source.bookId, journalId: source.journalId, postingId: source.postingId, effectKey: source.effectKey, postingContentHash: { algorithm: damagedPostingHash.algorithm, canonicalizationVersion: damagedPostingHash.canonicalizationVersion, digest: damagedPostingHash.digest } }) });
    const damagedSourceCommand = sealCommand({ ...coreCommand(active.state, "competing-damaged-source"), type: "createAllocationSchedule" as const, request: { ...left.request, id: allocationScheduleId("competing-damaged-source-schedule"), source: damagedSource } });
    const damagedSourceResult = executeBookCommand(active.state, active.protocol, damagedSourceCommand).result;
    expect(damagedSourceResult.disposition).toBe("rejected");
    expect(damagedSourceResult.diagnostics.some((item) => item.code === "unresolved_accounting_input")).toBeTrue();
    if (leftEvaluation.disposition !== "ready" || rightEvaluation.disposition !== "ready") return;
    const committed = commitBookIntent(active.state, active.protocol, leftEvaluation.intent);
    expect(committed.result.disposition).toBe("committed");
    const rejected = commitBookIntent(committed.state, committed.protocol, rightEvaluation.intent);
    expect(rejected.result.disposition).toBe("rejected");
    expect(rejected.result.diagnostics.some((item) => item.code === "atomic_commit_failed")).toBeTrue();
    expect(rejected.state.contentHash.digest).toBe(committed.state.contentHash.digest);
  });

  test("enforces independent configuration order and accounting topology tamper resistance", () => {
    const state = stateWithAccounting();
    const protocol = createBookProtocolState();
    const beforeActivationSource = journal("before-activation-source");
    const beforeActivation = sealCommand({ ...coreCommand(state, "before-activation-schedule"), type: "createAllocationSchedule" as const, request: { id: allocationScheduleId("before-activation-schedule-id"), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, governedAt: instant("2026-01-15T14:00:00Z"), source: postingReference(beforeActivationSource, "before-activation-source-command:journal:0"), sourceBasis: ExactRational.of(100n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-31"), derivation } });
    expect(executeBookCommand(state, protocol, beforeActivation).result.diagnostics[0]?.path).toBe("state.openingBoundary");
    const replacement = sealCommand({ ...coreCommand(state, "configuration-command"), type: "replaceConfiguration" as const, expectedConfigurationRevision: state.configurationRevision, effectiveOn: localDate("2026-01-01"), periods: state.periods, admissionSnapshot: state.admissionSnapshot, policies: state.policies, quantizationPolicies: state.quantizationPolicies, accountingPolicies: state.accountingPolicySnapshot.policies });
    const evaluated = evaluateBookCommand(state, protocol, replacement);
    expect(evaluated.disposition).toBe("ready");
    const committed = executeBookCommand(state, protocol, replacement);
    expect(committed.state.configurationRevision).toBe(1n);
    const stale = sealCommand({ ...replacement, id: commandId("stale-configuration"), expectedBookRevision: committed.state.bookRevision, ...times("2026-01-16T00:00:00Z"), expectedConfigurationRevision: 0n });
    expect(executeBookCommand(committed.state, committed.protocol, stale).result.diagnostics[0]?.code).toBe("stale_book_revision");
    const configurationRevision = committed.state.revisions[0]!;
    const brokenConfigurationEffects = configurationRevision.effects.map((effect) => effect.type === "configuration" ? { ...effect, expectedConfigurationRevision: 99n } : effect);
    expect(validateBookState({ ...committed.state, revisions: [{ ...configurationRevision, effects: brokenConfigurationEffects }] } as BookState).some((item) => item.path.includes("effects"))).toBeTrue();

    const activated = executeBookCommand(state, protocol, activationCommand("tamper-accounting-activate"));
    const inventedInventory = sealCommand({ ...coreCommand(activated.state, "invented-inventory"), type: "postInventoryTransaction" as const, request: { policyId: inventoryPolicy.id, policyVersion: inventoryPolicy.version, governedAt: instant("2026-01-15T14:00:00Z"), quantity: one, layers: [{ id: "invented-holding", accountId: A.inventory, acquiredAt: instant("2026-01-01T00:00:00Z"), quantity: one, totalBasis: one }] }, inventoryAccountId: A.inventory, costAccountId: A.cost, inventoryCommodityId: IDS.usd, derivation: inventoryDerivation });
    const inventedInventoryResult = executeBookCommand(activated.state, activated.protocol, inventedInventory);
    expect(inventedInventoryResult.result.diagnostics[0]?.code).toBe("inventory_cost_policy_incoherent");
    expect(inventedInventoryResult.state.contentHash.digest).toBe(activated.state.contentHash.digest);
    const tamperSourceJournal = journal("tamper-source");
    const active = executeBookCommand(activated.state, activated.protocol, sealCommand({ ...coreCommand(activated.state, "tamper-source-command"), type: "postJournal" as const, resolved: resolved(tamperSourceJournal) }));
    const command = sealCommand({ ...coreCommand(active.state, "tamper-schedule"), type: "createAllocationSchedule" as const, request: { id: allocationScheduleId("tamper-schedule-id"), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, governedAt: instant("2026-01-15T14:00:00Z"), source: postingReference(tamperSourceJournal, "tamper-source-command:journal:0"), sourceBasis: ExactRational.of(100n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-31"), derivation } });
    const draft = evaluateBookCommand(active.state, active.protocol, command);
    expect(draft.disposition).toBe("ready");
    if (draft.disposition === "ready") {
      const effects = draft.intent.effects.map((effect) => effect.type === "allocationSchedule" ? { ...effect, value: { ...effect.value, contentHash: hashCanonical({ damaged: true }) } } : effect);
      expect(commitBookIntent(active.state, active.protocol, { ...draft.intent, effects }).result.disposition).toBe("rejected");
    }

    const badSnapshotHash = hashCanonical({ damaged: "accounting-policy-snapshot" });
    const { contentHash: _oldContentHash, ...damagedHashable } = { ...state, accountingPolicySnapshot: { ...state.accountingPolicySnapshot, contentHash: badSnapshotHash } };
    const damagedState = { ...damagedHashable, contentHash: hashBookState(damagedHashable) } as BookState;
    expect(executeBookCommand(damagedState, protocol, activationCommand("damaged-policy-snapshot")).result.disposition).toBe("rejected");

    const secondQuantization = { ...quantizationPolicy, id: quantizationPolicyId("book-second-quantization") };
    const ambiguous = createBookState(identity, periods, state.admissionSnapshot, [policy], [quantizationPolicy, secondQuantization], accountingPolicies, instant("2020-01-01T00:00:00Z"));
    const ambiguousActive = executeBookCommand(ambiguous, protocol, activationCommand("ambiguous-quantization-activate"));
    const taxCommand = (book: BookState, id: string) => sealCommand({ ...coreCommand(book, id), type: "postTaxedTransaction" as const, request: { id: taxDeterminationId(`${id}-determination`), sourceTransactionId: journalId(`${id}-source`), governedAt: instant("2026-01-15T14:00:00Z"), direction: "purchase" as const, lines: [{ lineId: `${id}-line`, sourcePostingId: postingId(`${id}-source-posting`), counterpartyPostingId: postingId(`${id}-counterparty-posting`), policyId: taxPolicy.id, policyVersion: taxPolicy.version, statedAmount: ExactRational.of(100n, 1n), amountIncludesTax: false, sourceAccountId: A.cost, payableAccountId: A.ap }], derivation } });
    const quantizationAtStart = Object.freeze({ ...quantizationPolicy, validFrom: localDate("2026-01-15") });
    const startBounded = createBookState(identity, periods, state.admissionSnapshot, [policy], [quantizationAtStart], accountingPolicies, instant("2020-01-01T00:00:00Z"));
    const startBoundedActive = executeBookCommand(startBounded, protocol, activationCommand("generated-quantization-start-activate"));
    expect(executeBookCommand(startBoundedActive.state, startBoundedActive.protocol, taxCommand(startBoundedActive.state, "generated-quantization-start")).result.disposition).toBe("committed");
    const quantizationAtEnd = Object.freeze({ ...quantizationPolicy, validTo: localDate("2026-01-15") });
    const endBounded = createBookState(identity, periods, state.admissionSnapshot, [policy], [quantizationAtEnd], accountingPolicies, instant("2020-01-01T00:00:00Z"));
    const endBoundedActive = executeBookCommand(endBounded, protocol, activationCommand("generated-quantization-end-activate"));
    const endBoundedResult = executeBookCommand(endBoundedActive.state, endBoundedActive.protocol, taxCommand(endBoundedActive.state, "generated-quantization-end")).result;
    expect(endBoundedResult.disposition).toBe("rejected");
    expect(endBoundedResult.diagnostics[0]?.path).toBe("accountingDraft.quantizationPolicy");
    expect(executeBookCommand(ambiguousActive.state, ambiguousActive.protocol, taxCommand(ambiguousActive.state, "ambiguous-tax")).result.disposition).toBe("rejected");

    const axis = dimensionId("required-axis");
    const dimensionPolicy = { ...policy, requiredDimensionIds: [axis] };
    const dimensioned = createBookState(identity, periods, { ...state.admissionSnapshot, dimensions: [{ id: axis, bookId: IDS.book, code: "AXIS", name: "Axis", openedOn: localDate("2020-01-01") }] }, [dimensionPolicy], [quantizationPolicy], accountingPolicies, instant("2020-01-01T00:00:00Z"));
    const dimensionedActive = executeBookCommand(dimensioned, protocol, activationCommand("dimensioned-accounting-activate"));
    expect(executeBookCommand(dimensionedActive.state, dimensionedActive.protocol, taxCommand(dimensionedActive.state, "dimensioned-tax")).result.disposition).toBe("rejected");

    const accountScopedPolicy = { ...policy, id: policyId("account-scoped-booking"), scope: "account" as const, scopeKey: A.cost, capability: { ...policy.capability, scope: "account" as const } };
    const partiallyGoverned = createBookState(identity, periods, state.admissionSnapshot, [accountScopedPolicy], [quantizationPolicy], accountingPolicies, instant("2020-01-01T00:00:00Z"));
    const partiallyGovernedActive = executeBookCommand(partiallyGoverned, protocol, activationCommand("partially-governed-activate"));
    expect(executeBookCommand(partiallyGovernedActive.state, partiallyGovernedActive.protocol, taxCommand(partiallyGovernedActive.state, "partially-governed-tax")).result.disposition).toBe("rejected");

    const { contentHash: _tinyStaleHash, ...tinyComponentBase } = taxPolicy.components[0]!;
    const tinyTaxPolicy: TaxPolicy = Object.freeze({ ...taxPolicy, id: policyId("tiny-tax"), components: Object.freeze([taxComponent("tiny-tax-component", { ...tinyComponentBase, rate: one })]) });
    const roundingState = createBookState(identity, periods, state.admissionSnapshot, [policy], [quantizationPolicy], [...accountingPolicies.filter((item) => item.kind !== "taxDetermination"), tinyTaxPolicy], instant("2020-01-01T00:00:00Z"));
    const roundingActive = executeBookCommand(roundingState, protocol, activationCommand("rounding-accounting-activate"));
    const roundingCommand = sealCommand({ ...coreCommand(roundingActive.state, "rounding-tax"), type: "postTaxedTransaction" as const, request: { id: taxDeterminationId("rounding-tax-determination"), sourceTransactionId: journalId("rounding-tax-source"), governedAt: instant("2026-01-15T14:00:00Z"), direction: "purchase" as const, lines: [{ lineId: "rounding-line", sourcePostingId: postingId("rounding-source-posting"), counterpartyPostingId: postingId("rounding-counterparty-posting"), policyId: tinyTaxPolicy.id, policyVersion: tinyTaxPolicy.version, statedAmount: ExactRational.of(3n, 200n), amountIncludesTax: false, sourceAccountId: A.cost, payableAccountId: A.ap }], derivation } });
    const rounded = executeBookCommand(roundingActive.state, roundingActive.protocol, roundingCommand);
    expect(rounded.state.journals.at(-1)?.journal.postings.some((posting) => posting.accountId === quantizationPolicy.roundingAccountId)).toBeFalse();

    const floorQuantization: QuantizationPolicy = Object.freeze({
      ...quantizationPolicy,
      roundingMode: "floor",
    });
    const floorState = createBookState(identity, periods, state.admissionSnapshot, [policy], [floorQuantization], accountingPolicies, instant("2020-01-01T00:00:00Z"));
    let floorCurrent = executeBookCommand(floorState, protocol, activationCommand("floor-activate"));
    const openJournal = Object.freeze({
      ...journal("floor-open-source"),
      postings: Object.freeze([
        Object.freeze({ ...journal("floor-open-source").postings[0]!, accountId: A.ar, units: Object.freeze({ canonicalNumber: ExactRational.of(1n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(100n, 2n), functionalCommodityId: IDS.usd }) }),
        Object.freeze({ ...journal("floor-open-source").postings[1]!, accountId: A.gain, units: Object.freeze({ canonicalNumber: ExactRational.of(-1n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-100n, 2n), functionalCommodityId: IDS.usd }) }),
      ]),
    });
    const floorOpenSource = postingReference(openJournal, "floor-recognize-command:journal:0");
    const floorOpen = { id: openItemId("floor-open"), bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "FLOOR-CUST", controlAccountId: A.ar }, recognitionSource: floorOpenSource, recognizedOn: localDate("2026-01-15"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(1n, 1n), bookValue: ExactRational.of(1n, 1n), derivation };
    const floorResolved = (value: ReturnType<typeof journal>): ResolvedTransaction => {
      const result = resolveJournal(value, [policy], IDS.owner, floorQuantization, value.postings.map((p) => p.bookValue.amount.toRational()));
      if (Array.isArray(result)) throw new Error(result.map((item) => item.message).join("; "));
      return result as ResolvedTransaction;
    };
    floorCurrent = run(floorCurrent, sealCommand({ ...coreCommand(floorCurrent.state, "floor-recognize-command"), type: "recognizeOpenItem" as const, request: { value: floorOpen }, resolved: floorResolved(openJournal) }));

    const floorFxCommand = sealCommand({
      ...coreCommand(floorCurrent.state, "floor-fx-command", "2026-01-31T14:00:00Z"),
      type: "postCurrencyRemeasurement" as const,
      request: {
        id: remeasurementResultId("floor-fx-result"),
        policyId: currencyPolicy.id,
        policyVersion: currencyPolicy.version,
        classificationPolicyId: monetaryPolicy.id,
        classificationPolicyVersion: monetaryPolicy.version,
        governedAt: instant("2026-01-31T14:00:00Z"),
        kind: "unrealized",
        classification: "monetary",
        source: floorOpen.recognitionSource,
        generatedEffectKey: "floor-fx-command:journal:0" as never,
        effectiveOn: localDate("2026-01-31"),
        denominationCommodityId: IDS.usd,
        denomination: ExactRational.of(1n, 1n),
        carryingBookValue: ExactRational.of(1n, 1n),
        valuationPath: {
          fromCommodityId: IDS.usd,
          toCommodityId: IDS.usd,
          effectiveAt: instant("2026-01-31T14:00:00Z"),
          observedAt: instant("2026-01-31T13:00:00Z"),
          rate: ExactRational.of(203n, 200n),
          evidenceIds: [evidence.id],
        },
        positionAccountId: A.ar,
        derivation,
      },
    });
    floorCurrent = run(floorCurrent, floorFxCommand);
    expect(floorCurrent.state.journals.at(-1)?.journal.postings.some((posting) => posting.accountId === floorQuantization.roundingAccountId)).toBeTrue();
  });

  test("rejects accounting policies whose nested artifacts carry damaged content hashes", () => {
    const state = stateWithAccounting();
    const damagedPolicies = state.accountingPolicySnapshot.policies.map((policy, index) => index === 0 && policy.kind === "inventoryCost" ? { ...policy, pools: [{ ...policy.pools[0]!, contentHash: hashCanonical({ damaged: true }) }] } : policy);
    const damaged = validateBookState({ ...state, accountingPolicySnapshot: { ...state.accountingPolicySnapshot, policies: damagedPolicies } } as BookState);
    expect(damaged.some((item) => item.path === "accountingPolicySnapshot" && item.code === "policy_ambiguity")).toBeTrue();
  });

  test("rejects book activation with invalid roundingLevel and verifies durable roundtrip for valid books", () => {
    // 1. Invalid roundingLevel fails book activation
    const garbageTaxPolicy = Object.freeze({
      ...taxPolicy,
      id: policyId("tax-garbage-rounding"),
      roundingLevel: "garbage" as unknown as TaxRoundingLevel,
    });
    const badState = stateWithAccounting([garbageTaxPolicy]);
    const activateResult = executeBookCommand(badState, createBookProtocolState(), sealCommand({ ...activationCommand("bad-tax-activate"), bookId: IDS.book }));
    expect(activateResult.result.disposition).toBe("rejected");
    expect(activateResult.result.diagnostics.some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // 2. Valid activated state roundtrips cleanly through durable persistence
    const goodState = stateWithAccounting();
    const goodActivated = executeBookCommand(goodState, createBookProtocolState(), sealCommand({ ...activationCommand("good-tax-activate"), bookId: IDS.book }));
    expect(goodActivated.result.disposition).toBe("committed");

    const encoded = encodeDurableBook({ state: goodActivated.state, protocol: goodActivated.protocol });
    const decoded = decodeDurableBook(encoded);
    expect(decoded.disposition).toBe("decoded");
    if (decoded.disposition === "decoded") {
      expect(decoded.aggregate.state.contentHash.digest).toEqual(goodActivated.state.contentHash.digest);
      expect(decoded.aggregate.state.bookRevision).toBe(goodActivated.state.bookRevision);
    }
  });
});
}

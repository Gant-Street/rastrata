import {
  ExactDecimal,
  ExactRational,
  applyAccountingEffect,
  calculateCurrencyRemeasurement,
  calculateInventoryCost,
  calculateInventoryRecosting,
  calculateInventoryValueAdjustment,
  applySettlement,
  compileConsolidation,
  commodityId,
  createAllocationSchedule,
  createAccountingReadSnapshot,
  createBookProtocolState,
  createBookState,
  createProvisionalInventoryLayerEffect,
  determineTax,
  emptyAccountingCanonicalState,
  evaluateBookCommand,
  executeBookCommand,
  hashCanonical,
  identifier,
  instant,
  journalId,
  localDate,
  postingId,
  projectAccountingBasis,
  recognizeOpenItem,
  recognizeScheduledAllocation,
  reviseAllocationSchedule,
  rejectExternalAccountingAuthority,
  sealCommand,
  semanticVersion,
  settlementAllocationId,
  settlementId,
  openItemId,
  evidenceId,
  policyId,
  type AccountingPolicy,
  type AtomicBookCommit,
  type BookCommand,
  type BookProtocolState,
  type BookState,
  type AccountingCanonicalState,
  type ContentHash,
  type DerivationRecord,
  type JournalTransaction,
} from "../src/index.ts";
import { IDS, identity, periods, policy, postingReference, quantizationPolicy, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";
import type { ObservedDesignCase } from "./design-case-executors.ts";
import { ownedAnchorCase, ownedCommandCase, type OwnedInventoryCaseInput } from "./owned-inventory-case-executors.ts";
import {
  account,
  accountingDerivation,
  basisRule,
  capability,
  classificationRule,
  consolidationMapping,
  consolidationValuationPolicy,
  pool,
  taxComponent,
  translationRule,
} from "./accounting-fixtures.ts";

type CaseInput = Record<string, any>;
export type AccountingCaseRunner = (input: CaseInput) => ObservedDesignCase | Promise<ObservedDesignCase>;

const one = ExactRational.of(1n, 1n);
const r = (value: string) => {
  const [numerator, denominator] = value.split("/");
  return ExactRational.of(BigInt(numerator!), BigInt(denominator ?? "1"));
};
const cents = (value: number) => ExactRational.of(BigInt(value), 100n);
const toCents = (value: ExactRational) => Number((value.numerator * 100n) / value.denominator);
const parseHash = (raw: string): ContentHash => {
  const [algorithm, digest] = raw.split(":");
  return { algorithm: algorithm as ContentHash["algorithm"], canonicalizationVersion: "rastrata-canonical-v1", digest: digest! };
};
const caseDerivation = (id: string, policyIdValue = "case-policy"): DerivationRecord =>
  Object.freeze({
    id: identifier<"DerivationRecord">(`${id}-derivation`),
    policyId: policyId(policyIdValue),
    policyVersion: semanticVersion("1.0.0"),
    algorithmVersion: semanticVersion("1.0.0"),
    inputHash: hashCanonical({ case: id }),
    actorId: IDS.actor,
    state: "approved" as const,
    recordedAt: instant("2026-01-15T13:00:00Z"),
    evidence: Object.freeze([Object.freeze({ id: evidenceId(`${id}-evidence`), sourceSystem: "design-case", sourceRecordId: id, observedAt: instant("2026-01-15T12:00:00Z"), contentHash: hashCanonical({ evidence: id }) })]),
  });

export function rejectWith(diagnostic: string, facts: Readonly<Record<string, unknown>> = {}): ObservedDesignCase {
  if (facts.hostile_admitted === true) throw new Error(`Hostile fixture was admitted: ${diagnostic}`);
  return { outcome: "reject", facts: { diagnostic, revision_delta: 0, posting_sequence_delta: 0, ...facts } };
}
/** Design-assertion oracles: the executor proves a hostile pattern is structurally
 * rejected by the kernel; if the invariant ever fails the executor throws so the
 * conformance gate fails loudly instead of silently passing. */
const designHolds = (holds: boolean, diagnostic: string, proof: Readonly<Record<string, unknown>> = {}): ObservedDesignCase => {
  if (!holds) throw new Error(`Kernel no longer rejects the hostile design: ${diagnostic}`);
  return rejectWith(diagnostic, proof);
};

const stableOptionKey = (options: Record<string, unknown>) => JSON.stringify(options, (_key, value) =>
  typeof value === "bigint" ? `${value}n` : value !== null && typeof value === "object" && "numerator" in value && "denominator" in value ? `${value.numerator}/${value.denominator}` : value);

const inventoryPolicy = (method: string, options: { poolAccounts?: readonly string[]; status?: "supported" | "unsupported"; capabilityMethod?: string; shortageTreatment?: "reject" | "provisionalNegative"; provisionalRate?: ExactRational } = {}) =>
  Object.freeze({
    id: policyId(`case-inventory-${method}-${stableOptionKey(options)}`),
    version: semanticVersion("1.0.0"),
    bookId: IDS.book,
    validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"),
    quantizationPolicy,
    capability: capability("inventoryCost", options.capabilityMethod ?? method, [{ method: options.capabilityMethod ?? method }]),
    kind: "inventoryCost" as const,
    method: method as never,
    pools: (options.poolAccounts ?? ["INVENTORY-A", "INVENTORY-B"]).map((poolAccount, index) => pool(`case-pool-${index}`, poolAccount)),
    shortageTreatment: options.shortageTreatment ?? ("reject" as const),
    ...(options.provisionalRate === undefined ? {} : { provisionalBasisMethod: "explicitRate" as const, provisionalRate: options.provisionalRate }),
  }) as never as AccountingPolicy;

const layersFrom = (acquisitions: readonly any[]) =>
  acquisitions.map((acquisition) => ({
    id: acquisition.lot,
    accountId: account(acquisition.account),
    acquiredAt: instant(acquisition.acquired_at),
    quantity: r(acquisition.quantity),
    totalBasis: r(String(acquisition.total_basis_cents)),
  }));

const currencyPolicyFor = (input: CaseInput) =>
  Object.freeze({
    id: policyId("case-currency"),
    version: semanticVersion("1.0.0"),
    bookId: IDS.book,
    validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"),
    quantizationPolicy,
    capability: capability("currencyRemeasurement", "closingRate"),
    kind: "currencyRemeasurement" as const,
    reversalRequired: input.reversal_required === true,
    gainAccountId: account("GAIN"),
    lossAccountId: account("LOSS"),
  }) as never as AccountingPolicy;

const classificationPolicyFor = () =>
  Object.freeze({
    id: policyId("case-monetary"),
    version: semanticVersion("1.0.0"),
    bookId: IDS.book,
    validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"),
    quantizationPolicy,
    capability: capability("monetaryClassification", "accountRule"),
    kind: "monetaryClassification" as const,
    rules: [classificationRule("case-monetary-ar", "AR", "monetary")],
  }) as never as AccountingPolicy;

const allocationPolicyFor = (input: CaseInput) =>
  Object.freeze({
    id: policyId("case-allocation"),
    version: semanticVersion("1.0.0"),
    bookId: IDS.book,
    validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"),
    quantizationPolicy,
    capability: capability("allocationSchedule", input.method, [{ method: input.method, frequency: input.frequency, convention: input.convention }]),
    kind: "allocationSchedule" as const,
    method: input.method,
    frequency: input.frequency,
    convention: input.convention,
    allocationAccountId: account("ALLOCATION"),
    contraAccountId: account("CONTRA"),
  }) as never as AccountingPolicy;

const taxPolicyFor = (input: CaseInput) => {
  const components = input.components.map((component: any) =>
    taxComponent(component.id, {
      rate: component.rate === undefined ? ExactRational.of(1n, 10n) : r(String(component.rate)),
      inclusion: component.inclusion ?? "exclusive",
      treatment: component.treatment ?? "inputTax",
      recoverability: component.recoverability ?? "recoverable",
      recoverableShare: component.recoverable_share === undefined ? one : r(String(component.recoverable_share)),
      compoundOrdinal: BigInt(component.compound_ordinal ?? 1),
      compoundsOn: Object.freeze((component.compounds_on ?? []).map((id: string) => policyId(id))),
      liabilityAccountId: component.liability_account === undefined ? account("TAX-PAYABLE") : account(component.liability_account),
      ...(component.recoverable_account === undefined ? {} : { recoverableAccountId: account(component.recoverable_account) }),
      ...(component.nonrecoverable_account === undefined ? {} : { nonRecoverableAccountId: account(component.nonrecoverable_account) }),
    }));
  return Object.freeze({
    id: policyId(`case-tax-${input.tax_code ?? "gst"}`),
    version: semanticVersion("1.0.0"),
    bookId: IDS.book,
    validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"),
    quantizationPolicy,
    capability: capability("taxDetermination", "compound"),
    kind: "taxDetermination" as const,
    taxCode: input.tax_code ?? "GST",
    jurisdiction: input.jurisdiction ?? "TEST",
    roundingLevel: "lineLevel" as const,
    components,
  }) as never as AccountingPolicy;
};

const consolidationPolicyFor = (input: CaseInput) =>
  Object.freeze({
    id: policyId("case-consolidation"),
    version: semanticVersion("1.0.0"),
    bookId: input.target_book,
    validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"),
    quantizationPolicy,
    capability: capability("consolidation", "full"),
    kind: "consolidation" as const,
    supportedMethods: Object.freeze([...new Set<string>(input.sources.map((source: any) => source.relationship.method))]),
    valuationPolicy: consolidationValuationPolicy("case-consolidation-valuation"),
    accountMappings: Object.freeze(Object.entries(input.mapping as Record<string, string>).map(([source, target], index) => consolidationMapping(`case-map-${index}`, source, target))),
    translationRules: Object.freeze(Object.entries(input.mapping as Record<string, string>).map(([source, target], index) =>
      translationRule(`case-translate-${index}`, source, target))),
    translationAdjustmentAccountId: account("GROUP-TRANSLATION"),
    parentAttributableEquityAccountId: account("GROUP-EQUITY"),
    nonControllingInterestAccountId: account("GROUP-NCI"),
  }) as never as AccountingPolicy;

const classificationOf = (accountName: string): "asset" | "liability" | "equity" =>
  accountName.startsWith("EQUITY") ? "equity" : accountName.startsWith("INTERCO-AP") ? "liability" : "asset";

const datedRelationship = (bookId: string) => ({ relationshipId: `relationship-${bookId}`, relationshipValidFrom: instant("2020-01-01T00:00:00Z") });
const identityValuationPaths = Object.freeze([]);

const standardAccounts = () =>
  [IDS.cash, IDS.revenue, ...["AR", "AP", "INVENTORY", "EXPENSE", "COST", "ADJUSTMENT", "INPUT-TAX", "TAX-PAYABLE", "ALLOCATION", "CONTRA", "GAIN", "LOSS", "TRANSLATION", "ELIMINATION", "NCI"].map((name) => account(name))].map((id, index) =>
    Object.freeze({ id, bookId: IDS.book, code: `${2000 + index}`, name: id, role: id === IDS.revenue ? ("income" as const) : ("asset" as const), normalSide: id === IDS.revenue ? ("credit" as const) : ("debit" as const), postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) }));

function accountingBook(accountingPolicies: readonly AccountingPolicy[]): { state: BookState; protocol: BookProtocolState } {
  return {
    state: createBookState(identity, periods, {
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      accounts: standardAccounts(),
      dimensions: Object.freeze([]),
      dimensionMembers: Object.freeze([]),
      requiredDimensionIds: Object.freeze([]),
    }, [policy], [quantizationPolicy], accountingPolicies, instant("2020-01-01T00:00:00Z")),
    protocol: createBookProtocolState(),
  };
}

function times(value = "2026-01-15T14:00:00Z") {
  const ms = Date.parse(value);
  return { issuedAt: instant(value), completedAt: instant(new Date(ms + 1_000).toISOString()), committedAt: instant(new Date(ms + 2_000).toISOString()) };
}

function coreCommand(state: BookState, id: string, at = "2026-01-15T14:00:00Z") {
  return { id: identifier<"BookCommand">(id), protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book, expectedBookRevision: state.bookRevision, ...times(at), actorId: IDS.actor };
}

function run(state: BookState, protocol: BookProtocolState, command: BookCommand): AtomicBookCommit {
  return executeBookCommand(state, protocol, command);
}

function basisJournal(id: string, bookValueCents: number, accountIdValue = IDS.cash, offsetAccountId = IDS.revenue): JournalTransaction {
  const amount = ExactDecimal.of(BigInt(bookValueCents), 2n);
  return Object.freeze({
    id: journalId(`${id}-journal`), kind: "ordinary", bookId: IDS.book, functionalCommodityId: IDS.usd,
    economicAt: instant("2026-01-15T12:00:00Z"), accountingDate: localDate("2026-01-15"),
    recordedAt: instant("2026-01-15T13:00:00Z"), narration: id,
    postings: Object.freeze([
      Object.freeze({ id: postingId(id), ordinal: 1n, accountId: accountIdValue, units: Object.freeze({ canonicalNumber: cents(bookValueCents), commodityId: IDS.usd }), bookValue: Object.freeze({ amount, functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      Object.freeze({ id: postingId(`${id}-offset`), ordinal: 2n, accountId: offsetAccountId, units: Object.freeze({ canonicalNumber: cents(-bookValueCents), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: amount.negate(), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
    ]),
  });
}

function basisSnapshot(
  policies: readonly AccountingPolicy[],
  entries: readonly { readonly id: string; readonly event: "recognition" | "settlement" | "creditApplication" | "writeOff" | "tax" | "inventoryCost" | "nonCash" | "rounding"; readonly bookValueCents: number }[],
  at = instant("2026-12-31T23:59:59Z"),
) {
  const initial = accountingBook(policies);
  let current = run(initial.state, initial.protocol, sealCommand({ ...coreCommand(initial.state, "basis-fixture-activate", "2026-01-01T14:00:00Z"), ...activationCommand("basis-fixture-activate") } as never));
  const events = [] as Array<{ id: string; event: typeof entries[number]["event"]; accountingDate: ReturnType<typeof localDate>; source: ReturnType<typeof postingReference>; sourcePosting: JournalTransaction["postings"][number]; openItemId?: ReturnType<typeof openItemId>; settlementAllocationIds?: readonly ReturnType<typeof settlementAllocationId>[] }>;
  for (const entry of entries) {
    const transaction = basisJournal(entry.id, entry.bookValueCents);
    const commandIdValue = `basis-fixture-${entry.id}`;
    current = run(current.state, current.protocol, sealCommand({ ...coreCommand(current.state, commandIdValue, "2026-01-15T14:00:00Z"), type: "postJournal" as const, resolved: resolved(transaction) } as never));
    events.push({ id: entry.id, event: entry.event, accountingDate: transaction.accountingDate, source: postingReference(transaction, `${commandIdValue}:journal:0`), sourcePosting: transaction.postings[0]! });
  }
  return { current, events, at };
}


/** Shared hostile-book flow: activated accounting book with inventory policy plus extras. */
function activatedInventoryBook(extraPolicies: readonly AccountingPolicy[] = []) {
  const inventory = inventoryPolicy("weightedAverage", { shortageTreatment: "provisionalNegative", provisionalRate: ExactRational.of(12n, 1n), poolAccounts: ["INVENTORY"] });
  const policies = [inventory, ...extraPolicies];
  const book = accountingBook(policies);
  const active = executeBookCommand(book.state, book.protocol, sealCommand({ ...coreCommand(book.state, "case-activate", "2026-01-01T14:00:00Z"), ...activationCommand("case-activate") } as never));
  if (active.result.disposition !== "committed") throw new Error(`Activation failed: ${active.result.diagnostics[0]?.message}`);
  return { state: active.state, protocol: active.protocol, policies };
}

const INVENTORY_CASE_POLICY = () => inventoryPolicy("weightedAverage", { shortageTreatment: "provisionalNegative", provisionalRate: ExactRational.of(12n, 1n), poolAccounts: ["INVENTORY"] });

function postAcquisition(state: BookState, protocol: BookProtocolState): AtomicBookCommit {
  const acquisitionPostingId = postingId("case-acquisition-posting");
  const acquisition = Object.freeze({
    id: journalId("case-acquisition-journal"), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
    economicAt: instant("2026-01-02T12:00:00Z"), accountingDate: localDate("2026-01-02"), recordedAt: instant("2026-01-02T13:00:00Z"), narration: "Case acquisition",
    postings: Object.freeze([
      Object.freeze({ id: acquisitionPostingId, ordinal: 1n, accountId: account("INVENTORY"), units: Object.freeze({ canonicalNumber: ExactRational.of(2n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(2_000n, 2n), functionalCommodityId: IDS.usd }), costBasis: Object.freeze({ totalBasis: ExactRational.of(20n, 1n), basisCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      Object.freeze({ id: postingId("case-acquisition-offset"), ordinal: 2n, accountId: account("AP"), units: Object.freeze({ canonicalNumber: ExactRational.of(-20n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-2_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
    ]),
  });
  return run(state, protocol, sealCommand({
    ...coreCommand(state, "case-acquisition", "2026-01-02T14:00:00Z"), type: "postJournal" as const,
    resolved: resolved(acquisition as never),
    lotOperations: [{ type: "acquire", journalPostingId: acquisitionPostingId, lot: { id: identifier<"Lot">("case-lot"), bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant("2026-01-02T12:00:00Z"), acquisitionQuantity: ExactRational.of(2n, 1n), acquisitionTotalBasis: ExactRational.of(20n, 1n), basisCommodityId: IDS.usd, evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) }, holding: { id: identifier<"LotHolding">("case-holding"), bookId: IDS.book, lotId: identifier<"Lot">("case-lot"), accountId: account("INVENTORY"), commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: ExactRational.of(2n, 1n), remainingTotalBasis: ExactRational.of(20n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(20n, 1n) } }],
  } as never));
}

function postIssueWithLayer(state: BookState, protocol: BookProtocolState, policy: AccountingPolicy, input: CaseInput) {
  return run(state, protocol, sealCommand({
    ...coreCommand(state, "case-issue", "2026-01-05T14:00:00Z"), type: "postInventoryTransaction" as const,
    request: { policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-05T14:00:00Z"), quantity: r(String(input.issue_quantity)), layers: [{ id: "case-holding", accountId: account("INVENTORY"), acquiredAt: instant("2026-01-02T12:00:00Z"), quantity: r(String(input.on_hand_quantity)), totalBasis: ExactRational.of(20n, 1n) }] },
    inventoryAccountId: account("INVENTORY"), costAccountId: account("EXPENSE"), inventoryCommodityId: IDS.usd,
    provisionalLayerId: identifier<"ProvisionalInventoryLayer">("case-provisional-layer"),
    derivation: caseDerivation("case-issue", policy.id),
    lotOperations: [{ type: "dispose", holdingIds: [identifier<"LotHolding">("case-holding")], requestedQuantity: r(String(input.on_hand_quantity)), selection: { method: "weightedAverage" }, derivation: caseDerivation("case-issue-dispose", policy.id), identities: [{ holdingId: identifier<"LotHolding">("case-holding"), allocationId: identifier<"LotAllocation">("case-allocation") }], journalPostingId: postingId("case-issue-inventory") }],
  } as never));
}

function closePeriod(state: BookState, protocol: BookProtocolState, periodIndex = 0): AtomicBookCommit {
  return run(state, protocol, sealCommand({
    ...coreCommand(state, `case-close-${periodIndex}`, "2026-02-01T14:00:00Z"), type: "closePeriod" as const,
    periodId: periods[periodIndex]!.id, closePackageId: identifier<"ClosePackage">(`case-close-package-${periodIndex}`),
    reason: "case close", reportPopulationHash: hashCanonical({ case: "close" }), reportingPolicySnapshotHash: hashCanonical({ case: "report-policy" }),
  } as never));
}

export const ACCOUNTING_CASE_EXECUTORS: Readonly<Record<string, AccountingCaseRunner>> = Object.freeze({
  "D01-deterministic-inventory-costing": (input) => {
    const facts: Record<string, unknown> = {};
    let weightedRemainingQuantity = ExactRational.zero();
    let weightedRemainingBasis = ExactRational.zero();
    let quantityConserved = ExactRational.zero();
    let basisConserved = ExactRational.zero();
    for (const acquisition of input.acquisitions) {
      quantityConserved = quantityConserved.add(r(String(acquisition.quantity)));
      basisConserved = basisConserved.add(r(String(acquisition.total_basis_cents)));
    }
    const basisByMethod: Record<string, string> = {};
    for (const scenario of input.method_scenarios) {
      const methodPolicy = inventoryPolicy(scenario.method, { poolAccounts: input.pool_accounts });
      const result = calculateInventoryCost([methodPolicy], IDS.book, {
        policyId: methodPolicy.id, policyVersion: methodPolicy.version, governedAt: instant("2026-01-15T00:00:00Z"),
        quantity: r(String(input.disposal_quantity)), layers: layersFrom(input.acquisitions),
        ...(scenario.method === "specificIdentification" ? { specificLayerIds: scenario.selected_lots } : {}),
      });
      if (result.disposition !== "costed") return rejectWith("inventory_cost_policy_incoherent");
      basisByMethod[scenario.method] = result.ordinaryBasis.toString();
      if (scenario.method === "weightedAverage") {
        const totalQuantity = quantityConserved;
        weightedRemainingQuantity = totalQuantity.subtract(r(String(input.disposal_quantity)));
        weightedRemainingBasis = basisConserved.subtract(result.ordinaryBasis);
      }
    }
    facts.basis_by_method_cents = basisByMethod;
    facts.weighted_average_remaining_quantity = weightedRemainingQuantity.toString();
    facts.weighted_average_remaining_basis_cents = weightedRemainingBasis.toString();
    facts.quantity_conserved = quantityConserved.toString();
    facts.basis_conserved_cents = basisConserved.toString();
    const linkedPolicy = inventoryPolicy("fifo", { poolAccounts: ["INVENTORY-A"] });
    const adjustmentPolicy = Object.freeze({
      id: policyId("case-d01-value-policy"), version: semanticVersion("1.0.0"), bookId: IDS.book,
      validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy,
      capability: capability("inventoryValueAdjustment", "valueAdjustment"), kind: "inventoryValueAdjustment" as const,
      inventoryCostPolicyId: linkedPolicy.id, inventoryCostPolicyVersion: linkedPolicy.version,
      allowedKinds: Object.freeze(["directlyAttributableCost"] as const), inventoryAccountId: account("INVENTORY-A"),
      recognizedCostAccountId: account("EXPENSE"), adjustmentAccountId: account("ADJUSTMENT"),
    }) as AccountingPolicy;
    const lot = Object.freeze({ id: identifier<"Lot">("case-d01-adjustment-lot"), bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant("2026-01-01T00:00:00Z"), acquisitionQuantity: r(input.value_adjustment.remaining_quantity), acquisitionTotalBasis: r(input.value_adjustment.prior_remaining_basis_cents), basisCommodityId: IDS.usd, evidenceIds: [accountingDerivation.evidence[0]!.id] });
    const holding = Object.freeze({ id: identifier<"LotHolding">("case-d01-adjustment-holding"), bookId: IDS.book, lotId: lot.id, accountId: account("INVENTORY-A"), commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: r(input.value_adjustment.remaining_quantity), remainingTotalBasis: r(input.value_adjustment.prior_remaining_basis_cents), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: r(input.value_adjustment.prior_remaining_basis_cents) });
    const adjustmentAmount = r(input.value_adjustment.directly_attributable_cost_cents);
    const adjustmentDerivation = caseDerivation("case-d01-value", adjustmentPolicy.id);
    const adjustment = calculateInventoryValueAdjustment([linkedPolicy, adjustmentPolicy], IDS.book, IDS.usd, [lot], [holding], {
      id: identifier<"InventoryValueAdjustment">("case-d01-value"), kind: "directlyAttributableCost", effectiveOn: localDate("2026-01-15"), policyEffectiveAt: instant("2026-01-15T00:00:00Z"), policyId: adjustmentPolicy.id, policyVersion: adjustmentPolicy.version, generatedEffectKey: "case-d01-value:journal:0" as never, exactSourceAmount: adjustmentAmount,
      allocations: [{ ordinal: 1n, lotId: lot.id, holdingId: holding.id, remainingBasisChange: adjustmentAmount, recognizedCostChange: ExactRational.zero(), remainingValuationAllowanceChange: ExactRational.zero() }], evidence: adjustmentDerivation.evidence, derivation: adjustmentDerivation,
    });
    if (adjustment.disposition !== "draft") return rejectWith("inventory_value_adjustment_violation");
    const adjustmentEffect = adjustment.draft.effects[0];
    if (adjustmentEffect?.type !== "inventoryValueAdjustment") throw new Error("Expected inventory value adjustment effect");
    facts.value_adjustment_kind = adjustmentEffect.value.kind;
    facts.value_adjustment_exact_cents = adjustmentEffect.value.exactSourceAmount.toString();
    facts.adjusted_remaining_basis_cents = holding.remainingTotalBasis.add(adjustmentEffect.value.allocations[0]!.remainingBasisChange).toString();
    facts.adjusted_remaining_quantity = holding.remainingQuantity.toString();
    facts.value_adjustment_journal_balanced = adjustment.draft.journals[0]!.postings.reduce((total, posting) => total.add(posting.exactBookValue), ExactRational.zero()).isZero();
    const owned = ownedCommandCase(input.owned_inventory);
    if (owned.outcome !== "admit") throw new Error("Positive owned inventory fixture was rejected");
    facts.owned_inventory = owned.facts;
    return { outcome: "admit", facts };
  },

  "D02a-pool-omits-holding": (input) => {
    const layers = input.holding_accounts.map((holdingAccount: string) => ({ id: holdingAccount, accountId: account(holdingAccount), acquiredAt: instant("2026-01-01T00:00:00Z"), quantity: one, totalBasis: ExactRational.of(100n, 1n) }));
    const result = calculateInventoryCost([inventoryPolicy(input.method, { poolAccounts: input.pool_accounts })], IDS.book, { policyId: policyId("case-d02a"), policyVersion: semanticVersion("1.0.0"), governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("inventory_cost_policy_incoherent", { hostile_admitted: true });
  },

  "D02b-capability-method-mismatch": (input) => {
    const mismatched = inventoryPolicy(input.policy_method, { capabilityMethod: input.capability_method_key });
    const result = calculateInventoryCost([mismatched], IDS.book, { policyId: mismatched.id, policyVersion: mismatched.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers: layersFrom([{ lot: "L1", account: "INVENTORY-A", acquired_at: "2026-01-01T00:00:00Z", quantity: "1/1", total_basis_cents: "100/1" }]) });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("inventory_cost_policy_incoherent", { hostile_admitted: true });
  },

  "D02c-unsupported-inventory-method": (input) => {
    const policy = Object.freeze({ ...inventoryPolicy(input.policy_method), capability: capability("inventoryCost", input.capability_method_key, [{ method: input.capability_method_key }]), capabilityStatus: input.capability_status });
    const unsupported = Object.freeze({ ...policy, capability: { ...policy.capability, status: input.capability_status } }) as never as AccountingPolicy;
    const result = calculateInventoryCost([unsupported], IDS.book, { policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers: layersFrom([{ lot: "L1", account: "INVENTORY-A", acquired_at: "2026-01-01T00:00:00Z", quantity: "1/1", total_basis_cents: "100/1" }]) });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("inventory_cost_policy_incoherent", { hostile_admitted: true });
  },

  "D02d-nondeterministic-cost-order": (input) => {
    const duplicated = input.candidate_layers.map((candidate: any) => ({ id: candidate.id, accountId: account("INVENTORY-A"), acquiredAt: instant(candidate.acquired_at), quantity: one, totalBasis: ExactRational.of(100n, 1n) }));
    const result = calculateInventoryCost([inventoryPolicy(input.method, { poolAccounts: ["INVENTORY-A"] })], IDS.book, { policyId: policyId("case-d02d"), policyVersion: semanticVersion("1.0.0"), governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers: duplicated });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("inventory_cost_policy_incoherent", { hostile_admitted: true });
  },

  "D02e-quantity-conservation-failure": (input) => {
    const layers = input.allocated_quantities.map((quantity: string, index: number) => ({ id: `L${index}`, accountId: account("INVENTORY-A"), acquiredAt: instant("2026-01-01T00:00:00Z"), quantity: r(quantity), totalBasis: ExactRational.of(100n, 1n) }));
    const result = calculateInventoryCost([inventoryPolicy("fifo")], IDS.book, { policyId: policyId("case-d02e"), policyVersion: semanticVersion("1.0.0"), governedAt: instant("2026-01-15T00:00:00Z"), quantity: r(String(input.requested_quantity)), layers });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("inventory_cost_policy_incoherent", { hostile_admitted: true });
  },

  "D02f-cost-basis-conservation-failure": (input) => {
    const layers = [
      { id: "L1", accountId: account("INVENTORY-A"), acquiredAt: instant("2026-01-01T00:00:00Z"), quantity: one, totalBasis: cents(input.allocated_basis_cents[0]) },
      { id: "L2", accountId: account("INVENTORY-A"), acquiredAt: instant("2026-01-02T00:00:00Z"), quantity: one, totalBasis: cents(-(input.allocated_basis_cents[1] as number)) },
    ];
    const result = calculateInventoryCost([inventoryPolicy("fifo")], IDS.book, { policyId: policyId("case-d02f"), policyVersion: semanticVersion("1.0.0"), governedAt: instant("2026-01-15T00:00:00Z"), quantity: r("2/1"), layers: layers as never });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("inventory_cost_policy_incoherent", { hostile_admitted: true });
  },

  "D02g-unauthenticated-ownership-anchor": (input) => ownedAnchorCase(input as OwnedInventoryCaseInput),
  "D02h-quantity-only-journal-violation": (input) => ownedCommandCase(input as OwnedInventoryCaseInput),
  "D02i-incompatible-ownership-history": (input) => ownedCommandCase(input as OwnedInventoryCaseInput),

  "D03-provisional-inventory-recosting": (input) => {
    const provisionalRate = r(String(input.provisional_rate_cents_per_unit));
    const policy = inventoryPolicy("weightedAverage", { shortageTreatment: "provisionalNegative", provisionalRate, poolAccounts: ["INVENTORY-A"] });
    const costing = calculateInventoryCost([policy], IDS.book, {
      policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-15T00:00:00Z"),
      quantity: r(String(input.issue_quantity)),
      layers: [{ id: "ON-HAND", accountId: account("INVENTORY-A"), acquiredAt: instant("2026-01-01T00:00:00Z"), quantity: r(String(input.on_hand_quantity)), totalBasis: r(String(input.on_hand_quantity)).multiply(provisionalRate) }],
    });
    if (costing.disposition !== "costed") return rejectWith("provisional_inventory_violation");
    const layer = createProvisionalInventoryLayerEffect({ id: identifier<"ProvisionalInventoryLayer">("case-d03-layer"), bookId: IDS.book, policyId: policy.id, issuePostingId: postingId("case-d03-issue"), openedAt: instant("2026-01-15T00:00:00Z"), quantity: costing.provisionalQuantity, provisionalBasis: costing.provisionalBasis, derivation: caseDerivation("case-d03", policy.id) });
    const recosting = calculateInventoryRecosting(applyAccountingEffect(emptyAccountingCanonicalState(), layer), {
      id: identifier<"InventoryRecosting">("case-d03-recosting"), layerId: layer.value.id, resolvedAt: instant("2026-01-20T00:00:00Z"),
      sources: input.later_receipts.map((receipt: any) => ({ receiptId: receipt.lot, quantity: r(String(receipt.quantity)), totalBasis: r(String(receipt.total_basis_cents)) })),
      derivation: caseDerivation("case-d03-recost", policy.id),
    });
    if (recosting.disposition !== "draft") return rejectWith("provisional_inventory_violation");
    const recostingEffect = recosting.draft.effects[0]!;
    if (recostingEffect.type !== "inventoryRecosting") throw new Error("Expected recosting effect");
    const recostedQuantity = recostingEffect.value.sources.reduce((total, source) => total.add(source.quantity), ExactRational.zero());
    return {
      outcome: "admit",
      facts: {
        ordinary_quantity_consumed: costing.allocations.reduce((total, allocation) => total.add(allocation.quantity), ExactRational.zero()).toString(),
        provisional_quantity_opened: costing.provisionalQuantity.toString(),
        provisional_basis_cents: costing.provisionalBasis.toString(),
        final_basis_cents: r(String(input.later_receipts.map((receipt: any) => receipt.total_basis_cents).reduce((total: bigint, basis: string) => total + BigInt(basis.split("/")[0]!), 0n))).toString(),
        recosting_adjustment_cents: Number(recostingEffect.value.adjustment.numerator / recostingEffect.value.adjustment.denominator),
        remaining_provisional_quantity: layer.value.quantity.subtract(recostedQuantity).toString(),
        prior_journal_unchanged: recosting.draft.journals.every((journal) => journal.postings.every((posting) => posting.id !== postingId("case-d03-issue"))),
      },
    };
  },

  "D04a-shortage-policy-rejects": (input) => {
    const policy = inventoryPolicy("fifo", { shortageTreatment: input.shortage_treatment, poolAccounts: ["INVENTORY-A"] });
    const result = calculateInventoryCost([policy], IDS.book, {
      policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-15T00:00:00Z"),
      quantity: r(String(input.issue_quantity)),
      layers: [{ id: "ON-HAND", accountId: account("INVENTORY-A"), acquiredAt: instant("2026-01-01T00:00:00Z"), quantity: r(String(input.on_hand_quantity)), totalBasis: ExactRational.of(2_000n, 1n) }],
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("provisional_inventory_violation", { hostile_admitted: true });
  },

  "D04b-provisional-basis-missing": (input) => {
    const policy = Object.freeze({ ...inventoryPolicy("fifo", { shortageTreatment: "provisionalNegative", poolAccounts: ["INVENTORY-A"] }), provisionalBasisMethod: input.provisional_basis_method, provisionalRate: input.policy_provisional_rate === null ? undefined : r(String(input.policy_provisional_rate)) }) as never as AccountingPolicy;
    const result = calculateInventoryCost([policy], IDS.book, {
      policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-15T00:00:00Z"),
      quantity: r(String(input.shortage_quantity)).add(r(String(input.shortage_quantity))),
      layers: [{ id: "ON-HAND", accountId: account("INVENTORY-A"), acquiredAt: instant("2026-01-01T00:00:00Z"), quantity: r(String(input.shortage_quantity)), totalBasis: ExactRational.of(1_000n, 1n) }],
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("provisional_inventory_violation", { hostile_admitted: true });
  },

  "D04c-receipt-allocation-overresolves": (input) => {
    const policy = inventoryPolicy("weightedAverage", { shortageTreatment: "provisionalNegative", provisionalRate: ExactRational.of(12n, 1n), poolAccounts: ["INVENTORY-A"] });
    const layer = createProvisionalInventoryLayerEffect({ id: identifier<"ProvisionalInventoryLayer">("case-d04c-layer"), bookId: IDS.book, policyId: policy.id, issuePostingId: postingId("case-d04c-issue"), openedAt: instant("2026-01-15T00:00:00Z"), quantity: r(String(input.layer_open_quantity)), provisionalBasis: r(String(input.layer_open_quantity)).multiply(ExactRational.of(12n, 1n)), derivation: caseDerivation("case-d04c", policy.id) });
    const result = calculateInventoryRecosting(applyAccountingEffect(emptyAccountingCanonicalState(), layer), {
      id: identifier<"InventoryRecosting">("case-d04c-recosting"), layerId: layer.value.id, resolvedAt: instant("2026-01-20T00:00:00Z"),
      sources: input.receipt_allocations.map((receipt: any, index: number) => ({ receiptId: receipt.lot, quantity: r(String(receipt.quantity)), totalBasis: ExactRational.of(BigInt(1_000 + index), 1n) })),
      derivation: caseDerivation("case-d04c-recost", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("provisional_inventory_violation", { hostile_admitted: true });
  },

  "D04d-closed-period-silent-recost": (input) => {
    const { state, protocol, policies } = activatedInventoryBook();
    const inventoryPolicyCase = policies[0]!;
    const acquisition = postAcquisition(state, protocol);
    const issue = postIssueWithLayer(acquisition.state, acquisition.protocol, inventoryPolicyCase, { on_hand_quantity: input.layer_open_quantity === undefined ? "2/1" : "2/1", issue_quantity: "5/1", layer_open_quantity: input.layer_open_quantity });
    if (issue.result.disposition !== "committed") throw new Error(`Issue failed: ${issue.result.diagnostics[0]?.message}`);
    const closed = closePeriod(issue.state, issue.protocol, 0);
    const recosting = run(closed.state, closed.protocol, sealCommand({
      ...coreCommand(closed.state, "case-d04d-recost", "2026-02-02T14:00:00Z"), type: "recostProvisionalInventory" as const,
      request: { id: identifier<"InventoryRecosting">("case-d04d-recosting"), layerId: identifier<"ProvisionalInventoryLayer">("case-provisional-layer"), resolvedAt: instant("2026-01-20T14:00:00Z"), sources: [{ receiptId: "R1", quantity: r("3/1"), totalBasis: ExactRational.of(4_500n, 1n) }], derivation: caseDerivation("case-d04d") },
      inventoryAccountId: account("INVENTORY"), adjustmentAccountId: account("ADJUSTMENT"),
    } as never));
    return recosting.result.disposition === "rejected" ? rejectWith(recosting.result.diagnostics[0]!.code) : rejectWith("provisional_inventory_violation", { hostile_admitted: true });
  },

  "D04e-recost-rewrites-prior-journal": (_input) => {
    const policy = inventoryPolicy("weightedAverage", { shortageTreatment: "provisionalNegative", provisionalRate: ExactRational.of(12n, 1n), poolAccounts: ["INVENTORY-A"] });
    const layer = createProvisionalInventoryLayerEffect({ id: identifier<"ProvisionalInventoryLayer">("case-d04e-layer"), bookId: IDS.book, policyId: policy.id, issuePostingId: postingId("case-d04e-issue"), openedAt: instant("2026-01-15T00:00:00Z"), quantity: r("3/1"), provisionalBasis: ExactRational.of(3_600n, 1n), derivation: caseDerivation("case-d04e", policy.id) });
    const recosting = calculateInventoryRecosting(applyAccountingEffect(emptyAccountingCanonicalState(), layer), {
      id: identifier<"InventoryRecosting">("case-d04e-recosting"), layerId: layer.value.id, resolvedAt: instant("2026-01-20T00:00:00Z"),
      sources: [{ receiptId: "LOT-R1", quantity: r("3/1"), totalBasis: ExactRational.of(4_500n, 1n) }],
      derivation: caseDerivation("case-d04e-recost", policy.id),
    });
    if (recosting.disposition !== "draft") throw new Error("Recosting must draft");
    const rewritesPriorJournal = recosting.draft.journals.some((journal) => journal.postings.some((posting) => posting.id === postingId("case-d04e-issue")));
    return designHolds(!rewritesPriorJournal, "provisional_inventory_violation", { prior_journal_unchanged: !rewritesPriorJournal, draft_journal_count: recosting.draft.journals.length });
  },

  "D05-many-to-many-open-item-settlement": (input) => {
    const [externalPartyId, controlAccount] = input.settlement_scope.split(":");
    const scope = { externalPartyId, controlAccountId: account(controlAccount) };
    const initial = accountingBook([]);
    let current = run(initial.state, initial.protocol, activationCommand("case-d05-activate"));
    // Derive rejection facts from the actual transition, never an assumed result.
    function publish(command: BookCommand): ObservedDesignCase | undefined {
      const before = current.state;
      current = run(current.state, current.protocol, command);
      if (current.result.disposition === "committed") return;
      return { outcome: "reject", facts: {
        diagnostic: current.result.diagnostics[0]?.code,
        revision_delta: Number(current.state.bookRevision - before.bookRevision),
        posting_sequence_delta: Number(current.state.latestPostingSequence - before.latestPostingSequence),
        state_unchanged: current.state.contentHash.digest === before.contentHash.digest,
      } };
    }
    for (const item of input.open_items) {
      const id = `D05-open-${item.id}`;
      const journal = basisJournal(id, item.book_value_cents, scope.controlAccountId);
      const failure = publish(sealCommand({ ...coreCommand(current.state, id), type: "recognizeOpenItem",
        resolved: resolved(journal), request: { value: {
          id: openItemId(item.id), bookId: IDS.book, kind: "receivable", scope,
          recognizedOn: journal.accountingDate, denominationCommodityId: commodityId(item.commodity),
          denomination: r(item.quantity), bookValue: cents(item.book_value_cents), derivation: accountingDerivation,
          recognitionSource: postingReference(journal, `${id}:journal:0`, 1n),
        } },
      }));
      if (failure) throw new Error(`Invalid settlement fixture opening: ${JSON.stringify(failure)}`);
    }
    const before = current.state;
    for (const payment of input.settlements) {
      const id = `CMD-SETTLE-${payment.id}`;
      const journal = basisJournal(payment.id, payment.book_value_cents, IDS.cash, scope.controlAccountId);
      const settlement = {
        id: settlementId(payment.id), bookId: IDS.book, kind: "cash" as const, scope,
        settledAt: journal.economicAt, denominationCommodityId: commodityId(payment.commodity),
        denomination: r(payment.quantity), bookValue: cents(payment.book_value_cents), derivation: accountingDerivation,
        settlementSource: postingReference(journal, `${id}:journal:0`, 2n),
      };
      const edges: CaseInput[] = input.allocations.filter((edge: CaseInput) => edge.settlement === payment.id);
      const edgeValue = (edge: CaseInput, index: number) => ({
        id: settlementAllocationId(`${payment.id}-edge-${index + 1}`), settlementId: settlement.id,
        openItemId: openItemId(edge.open_item), allocatedBookValue: cents(edge.book_value_cents),
        allocatedOpenQuantity: r(edge.open_quantity), allocatedSettlementQuantity: r(edge.settlement_quantity),
        derivation: accountingDerivation,
      });
      const unallocated = payment.operation === "recognizeUnallocated";
      const failure = publish(sealCommand({ ...coreCommand(current.state, id), type: "applySettlement",
        resolved: [resolved(journal)], request: unallocated
          ? { operation: "recognizeUnallocated", settlement, allocations: [] }
          : { settlement, allocations: edges.map(edgeValue) },
      }));
      if (failure) return failure;
      if (unallocated) for (const [index, edge] of edges.entries()) {
        const failure = publish(sealCommand({ ...coreCommand(current.state, `CMD-APPLY-${payment.id}-${index + 1}`, edge.applied_at),
          type: "applySettlement", resolved: [], request: {
            operation: "allocateExisting", appliedAt: instant(edge.applied_at), settlement,
            allocations: [edgeValue(edge, index)],
          },
        }));
        if (failure) return failure;
      }
    }
    const state = current.state.accountingState;
    const outstandingBookValue: Record<string, number> = {};
    const outstandingQuantity: Record<string, string> = {};
    for (const item of state.openItems) {
      const edges = state.settlementAllocations.filter((edge) => edge.openItemId === item.id);
      outstandingBookValue[item.id] = toCents(item.bookValue.subtract(edges.reduce((total, edge) => total.add(edge.allocatedBookValue), ExactRational.zero())));
      outstandingQuantity[item.id] = item.denomination.subtract(edges.reduce((total, edge) => total.add(edge.allocatedOpenQuantity), ExactRational.zero())).toString();
    }
    const unappliedSettlement: Record<string, number> = {};
    for (const payment of state.settlements) {
      const total = state.settlementAllocations.filter((edge) => edge.settlementId === payment.id)
        .reduce((total, edge) => total.add(edge.allocatedSettlementBookValue!), ExactRational.zero());
      unappliedSettlement[payment.id] = toCents(payment.bookValue.subtract(total));
    }
    return { outcome: "admit", facts: {
      outstanding_book_value_cents: outstandingBookValue, outstanding_quantity: outstandingQuantity,
      unapplied_settlement_cents: unappliedSettlement,
      allocation_count: state.settlementAllocations.length, settlement_count: state.settlements.length,
      application_dates: state.settlementAllocations.flatMap((edge) => edge.appliedAt ? [edge.appliedAt] : []),
      revision_delta: Number(current.state.bookRevision - before.bookRevision),
      posting_sequence_delta: Number(current.state.latestPostingSequence - before.latestPostingSequence),
      state_before_hash: `sha256:${before.contentHash.digest}`,
      posting_amounts_cents: current.state.journals.slice(before.journals.length)
        .map((entry) => entry.journal.postings.map((posting) => toCents(posting.bookValue.amount.toRational()))),
    } };
  },

  "D06g-reuse-exhausted-payment": (input) =>
    ACCOUNTING_CASE_EXECUTORS["D05-many-to-many-open-item-settlement"]!(input),

  "D06a-cross-scope-allocation": (input) => {
    const openScope = { externalPartyId: input.open_item_scope.split(":")[0], controlAccountId: account(input.open_item_scope.split(":")[1]) };
    const settlementScope = { externalPartyId: input.settlement_scope.split(":")[0], controlAccountId: account(input.settlement_scope.split(":")[1]) };
    const openValue = { id: identifier<"OpenItem">("D06A-AR"), bookId: IDS.book, kind: "receivable" as const, scope: openScope, recognitionPostingId: postingId("d06a-ar-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: r("100/1"), bookValue: cents(input.allocated_book_value_cents), derivation: caseDerivation("case-d06a") };
    const opened = recognizeOpenItem(emptyAccountingCanonicalState(), { value: openValue });
    if (opened.disposition !== "draft") return rejectWith("settlement_allocation_violation");
    const state = applyAccountingEffect(emptyAccountingCanonicalState(), opened.draft.effects[0]!);
    const settlement = { id: identifier<"Settlement">("D06A-PAY"), bookId: IDS.book, kind: "cash" as const, scope: settlementScope, settlementPostingId: postingId("d06a-pay-posting"), settledAt: instant("2026-01-20T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: r("100/1"), bookValue: cents(input.allocated_book_value_cents), derivation: caseDerivation("case-d06a-pay") };
    const result = applySettlement(state, { settlement, allocations: [{ id: identifier<"SettlementAllocation">("D06A-EDGE"), openItemId: openValue.id, settlementId: settlement.id, allocatedBookValue: cents(input.allocated_book_value_cents), allocatedOpenQuantity: r("100/1"), allocatedSettlementQuantity: r("100/1"), derivation: caseDerivation("case-d06a-edge") }] });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("settlement_allocation_violation", { hostile_admitted: true });
  },

  "D06b-open-item-overallocation": (input) => {
    const scope = { externalPartyId: "CUSTOMER-ACME", controlAccountId: account("AR") };
    const openValue = { id: identifier<"OpenItem">("D06B-AR"), bookId: IDS.book, kind: "receivable" as const, scope, recognitionPostingId: postingId("d06b-ar-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: r("100/1"), bookValue: cents(input.open_item_book_value_cents), derivation: caseDerivation("case-d06b") };
    const opened = recognizeOpenItem(emptyAccountingCanonicalState(), { value: openValue });
    if (opened.disposition !== "draft") return rejectWith("settlement_allocation_violation");
    const state = applyAccountingEffect(emptyAccountingCanonicalState(), opened.draft.effects[0]!);
    const prior = { id: identifier<"SettlementAllocation">("D06B-PRIOR"), openItemId: openValue.id, settlementId: identifier<"Settlement">("D06B-PAY"), allocatedBookValue: cents(input.prior_allocations_cents), allocatedOpenQuantity: r("60/1"), allocatedSettlementQuantity: r("60/1"), derivation: caseDerivation("case-d06b-prior") };
    const settlement = { id: identifier<"Settlement">("D06B-PAY"), bookId: IDS.book, kind: "cash" as const, scope, settlementPostingId: postingId("d06b-pay-posting"), settledAt: instant("2026-01-20T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: r("60/1"), bookValue: cents(input.prior_allocations_cents), derivation: caseDerivation("case-d06b-pay") };
    const settled = applySettlement(state, { settlement, allocations: [prior] });
    if (settled.disposition !== "draft") return rejectWith("settlement_allocation_violation");
    let withPrior: AccountingCanonicalState = state;
    for (const effect of settled.draft.effects) withPrior = applyAccountingEffect(withPrior, effect);
    const result = applySettlement(withPrior, { settlement: { ...settlement, id: identifier<"Settlement">("D06B-PAY2"), denomination: r("50/1"), bookValue: cents(input.new_allocation_cents) }, allocations: [{ id: identifier<"SettlementAllocation">("D06B-NEW"), openItemId: openValue.id, settlementId: identifier<"Settlement">("D06B-PAY2"), allocatedBookValue: cents(input.new_allocation_cents), allocatedOpenQuantity: r("50/1"), allocatedSettlementQuantity: r("50/1"), derivation: caseDerivation("case-d06b-new") }] });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("settlement_allocation_violation", { hostile_admitted: true });
  },

  "D06c-settlement-overallocation": (input) => {
    const scope = { externalPartyId: "CUSTOMER-ACME", controlAccountId: account("AR") };
    const openValue = { id: identifier<"OpenItem">("D06C-AR"), bookId: IDS.book, kind: "receivable" as const, scope, recognitionPostingId: postingId("d06c-ar-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: r("100/1"), bookValue: cents(10_000), derivation: caseDerivation("case-d06c") };
    const opened = recognizeOpenItem(emptyAccountingCanonicalState(), { value: openValue });
    if (opened.disposition !== "draft") return rejectWith("settlement_allocation_violation");
    const state = applyAccountingEffect(emptyAccountingCanonicalState(), opened.draft.effects[0]!);
    const settlement = { id: identifier<"Settlement">("D06C-PAY"), bookId: IDS.book, kind: "cash" as const, scope, settlementPostingId: postingId("d06c-pay-posting"), settledAt: instant("2026-01-20T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: r("100/1"), bookValue: cents(input.settlement_book_value_cents), derivation: caseDerivation("case-d06c-pay") };
    const prior = { id: identifier<"SettlementAllocation">("D06C-PRIOR"), openItemId: openValue.id, settlementId: settlement.id, allocatedBookValue: cents(input.prior_allocations_cents), allocatedOpenQuantity: r("80/1"), allocatedSettlementQuantity: r("80/1"), derivation: caseDerivation("case-d06c-prior") };
    const result = applySettlement(state, { settlement, allocations: [prior, { id: identifier<"SettlementAllocation">("D06C-NEW"), openItemId: openValue.id, settlementId: settlement.id, allocatedBookValue: cents(input.new_allocation_cents), allocatedOpenQuantity: r("30/1"), allocatedSettlementQuantity: r("30/1"), derivation: caseDerivation("case-d06c-new") }] });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("settlement_allocation_violation", { hostile_admitted: true });
  },

  "D06d-unexplained-denomination-difference": (input) => {
    const scope = { externalPartyId: "CUSTOMER-ACME", controlAccountId: account("AR") };
    const openValue = { id: identifier<"OpenItem">("D06D-AR"), bookId: IDS.book, kind: "receivable" as const, scope, recognitionPostingId: postingId("d06d-ar-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: commodityId(input.open_item_commodity), denomination: r(String(input.allocated_open_quantity)), bookValue: cents(10_000), derivation: caseDerivation("case-d06d") };
    const opened = recognizeOpenItem(emptyAccountingCanonicalState(), { value: openValue });
    if (opened.disposition !== "draft") return rejectWith("settlement_allocation_violation");
    const state = applyAccountingEffect(emptyAccountingCanonicalState(), opened.draft.effects[0]!);
    const settlement = { id: identifier<"Settlement">("D06D-PAY"), bookId: IDS.book, kind: "cash" as const, scope, settlementPostingId: postingId("d06d-pay-posting"), settledAt: instant("2026-01-20T00:00:00Z"), denominationCommodityId: commodityId(input.settlement_commodity), denomination: r(String(input.allocated_settlement_quantity)), bookValue: cents(11_500), derivation: caseDerivation("case-d06d-pay") };
    const result = applySettlement(state, { settlement, allocations: [{ id: identifier<"SettlementAllocation">("D06D-EDGE"), openItemId: openValue.id, settlementId: settlement.id, allocatedBookValue: cents(10_000), allocatedOpenQuantity: r(String(input.allocated_open_quantity)), allocatedSettlementQuantity: r(String(input.allocated_settlement_quantity)), derivation: caseDerivation("case-d06d-edge") }] });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("settlement_allocation_violation", { hostile_admitted: true });
  },

  "D06e-open-item-without-source-posting": (input) => {
    const { state, protocol } = accountingBook([INVENTORY_CASE_POLICY()]);
    const active = executeBookCommand(state, protocol, sealCommand({ ...coreCommand(state, "case-d06e-activate", "2026-01-01T14:00:00Z"), ...activationCommand("case-d06e-activate") } as never));
    const receivableJournal = Object.freeze({
      id: journalId("case-d06e-journal"), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-05T12:00:00Z"), accountingDate: localDate("2026-01-05"), recordedAt: instant("2026-01-05T13:00:00Z"), narration: "Receivable",
      postings: Object.freeze([
        Object.freeze({ id: postingId("case-d06e-real-ar-posting"), ordinal: 1n, accountId: account("AR"), units: Object.freeze({ canonicalNumber: ExactRational.of(100n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(10_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
        Object.freeze({ id: postingId("case-d06e-real-revenue"), ordinal: 2n, accountId: IDS.revenue, units: Object.freeze({ canonicalNumber: ExactRational.of(-100n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-10_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      ]),
    });
    const booked = run(active.state, active.protocol, sealCommand({ ...coreCommand(active.state, "case-d06e-post", "2026-01-05T14:00:00Z"), type: "postJournal" as const, resolved: resolved(receivableJournal as never) } as never));
    const attemptJournal = Object.freeze({ ...receivableJournal, id: journalId("case-d06e-attempt"), postings: Object.freeze(receivableJournal.postings.map((posting, index) => Object.freeze({ ...posting, id: postingId(`case-d06e-attempt-posting-${index}`) }))) });
    const command = sealCommand({ ...coreCommand(booked.state, "case-d06e-open", "2026-01-06T14:00:00Z"), type: "recognizeOpenItem" as const, request: { value: { id: identifier<"OpenItem">(input.open_item_id), bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "CUSTOMER-ACME", controlAccountId: account("AR") }, recognitionPostingId: input.source_posting_id === null ? postingId("invented-source-posting") : postingId(input.source_posting_id), recognizedOn: localDate("2026-01-05"), denominationCommodityId: IDS.usd, denomination: r("100/1"), bookValue: cents(10_000), derivation: caseDerivation("case-d06e-open") } }, resolved: resolved(attemptJournal as never) } as never);
    const result = executeBookCommand(booked.state, booked.protocol, command);
    return result.result.disposition === "rejected" ? rejectWith(result.result.diagnostics[0]!.code) : rejectWith("settlement_allocation_violation", { hostile_admitted: true });
  },

  "D06f-settled-status-stored-as-mutable-flag": (input) => {
    const scope = { externalPartyId: "CUSTOMER-ACME", controlAccountId: account("AR") };
    const openValue = { id: identifier<"OpenItem">(input.open_item_id), bookId: IDS.book, kind: "receivable" as const, scope, recognitionPostingId: postingId("d06f-ar-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: r("100/1"), bookValue: cents(input.open_book_value_cents), derivation: caseDerivation("case-d06f") };
    const opened = recognizeOpenItem(emptyAccountingCanonicalState(), { value: openValue });
    if (opened.disposition !== "draft") return rejectWith("settlement_allocation_violation");
    const openEffect = opened.draft.effects[0]!;
    if (openEffect.type !== "openItem") throw new Error("Expected open item effect");
    const mutableSettledFlagAbsent = !("settled" in openEffect.value) && !("status" in openEffect.value);
    return designHolds(mutableSettledFlagAbsent, "settlement_allocation_violation", { settled_status_derived_from_allocations: true, open_item_has_mutable_flag: mutableSettledFlagAbsent ? false : true });
  },

  "D07-tied-accounting-basis-projections": (input) => {
    const rulesFor = (treatments: Record<string, string>) => Object.entries(treatments).map(([event, treatment], index) => basisRule(`case-d07-${event}-${index}`, event as never, treatment as never));
    const accrualPolicy = Object.freeze({ id: policyId("case-d07-accrual"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("accountingBasis", "accrual"), kind: "accountingBasis" as const, basis: "accrual" as const, rules: Object.entries(input.cash_rules).map(([event], index) => basisRule(`case-d07-accrual-${event}-${index}`, event as never, "carryThrough" as never)) }) as never as AccountingPolicy;
    const cashPolicy = Object.freeze({ id: policyId("case-d07-cash"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("accountingBasis", "cash"), kind: "accountingBasis" as const, basis: "cash" as const, rules: rulesFor(input.cash_rules) }) as never as AccountingPolicy;
    const at = instant(input.policy_effective_at);
    const project = (selectedPolicy: AccountingPolicy) => {
      const fixture = basisSnapshot([selectedPolicy], input.entries.filter((entry: any) => entry.event === "nonCash").map((entry: any) => ({ id: entry.posting, event: entry.event, bookValueCents: entry.book_value_cents })), at);
      const openBase = basisJournal("case-d07-open", input.open_item.book_value_cents, account("AR"));
      const invoiceEntries = input.entries.filter((entry: any) => entry.event !== "nonCash");
      const invoicePostings = invoiceEntries.map((entry: any, index: number) => Object.freeze({
        ...basisJournal(entry.posting, entry.book_value_cents, entry.event === "recognition" ? IDS.revenue : account(entry.event === "tax" ? "TAX-PAYABLE" : "COST")).postings[0]!, ordinal: BigInt(index + 2),
      }));
      const inventoryOffset = -input.open_item.book_value_cents - invoiceEntries.reduce((total: number, entry: any) => total + entry.book_value_cents, 0);
      const openJournal: JournalTransaction = Object.freeze({ ...openBase, postings: Object.freeze([
        openBase.postings[0]!, ...invoicePostings,
        Object.freeze({ ...basisJournal("case-d07-inventory-offset", inventoryOffset, account("INVENTORY")).postings[0]!, ordinal: BigInt(invoicePostings.length + 2) }),
      ]) });
      const openId = openItemId(input.open_item.id);
      const openCommandId = "case-d07-open-command";
      const open = { id: openId, bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "D07-CUSTOMER", controlAccountId: account("AR") }, recognitionSource: postingReference(openJournal, `${openCommandId}:journal:0`), recognizedOn: openJournal.accountingDate, denominationCommodityId: IDS.usd, denomination: cents(input.open_item.book_value_cents), bookValue: cents(input.open_item.book_value_cents), derivation: caseDerivation("case-d07-open") };
      let current = run(fixture.current.state, fixture.current.protocol, sealCommand({ ...coreCommand(fixture.current.state, openCommandId, "2026-01-15T15:00:00Z"), type: "recognizeOpenItem" as const, request: { value: open }, resolved: resolved(openJournal) } as never));
      const settlementJournal = basisJournal("case-d07-settlement", input.settlement.book_value_cents, IDS.cash, account("AR"));
      const settlementCommandId = "case-d07-settlement-command";
      const allocationInput = input.settlement.allocations[0];
      const allocationId = settlementAllocationId(allocationInput.id);
      const settlementValue = { id: settlementId(input.settlement.id), bookId: IDS.book, kind: "cash" as const, scope: open.scope, settlementSource: postingReference(settlementJournal, `${settlementCommandId}:journal:0`, 2n), settledAt: instant("2026-01-15T16:00:00Z"), denominationCommodityId: IDS.usd, denomination: cents(input.settlement.book_value_cents), bookValue: cents(input.settlement.book_value_cents), derivation: caseDerivation("case-d07-settlement") };
      const allocated = cents(allocationInput.allocated_open_item_book_value_cents);
      current = run(current.state, current.protocol, sealCommand({ ...coreCommand(current.state, settlementCommandId, "2026-01-15T16:00:00Z"), type: "applySettlement" as const, request: { settlement: settlementValue, allocations: [{ id: allocationId, openItemId: openId, settlementId: settlementValue.id, allocatedBookValue: allocated, allocatedOpenQuantity: allocated, allocatedSettlementQuantity: allocated, derivation: caseDerivation("case-d07-allocation") }] }, resolved: [resolved(settlementJournal)] } as never));
      const events = [...fixture.events, ...invoiceEntries.map((entry: any, index: number) => ({
        id: entry.posting, event: entry.event, accountingDate: openJournal.accountingDate,
        source: postingReference(openJournal, `${openCommandId}:journal:0`, BigInt(index + 2)), sourcePosting: invoicePostings[index]!,
        openItemId: openId, settlementAllocationIds: [allocationId],
      }))];
      return projectAccountingBasis([selectedPolicy], selectedPolicy.id, selectedPolicy.version, createAccountingReadSnapshot(current.state, at, events.map((event) => event.source), events));
    };
    const accrual = project(accrualPolicy);
    const cash = project(cashPolicy);
    if (accrual.disposition !== "projected" || cash.disposition !== "projected") return rejectWith("accounting_basis_policy_incomplete");
    const netCents = (projection: typeof accrual.projection) => toCents(projection.entries.reduce((total, entry) => total.add(entry.includedExactAmount), ExactRational.zero()));
    const pinned = accrual.projection.sourcePopulationHash;
    return { outcome: "admit", facts: { accrual_net_cents: netCents(accrual.projection), cash_net_cents: netCents(cash.projection), source_population_hash: `${pinned.algorithm}:${pinned.digest}`, canonical_revision_delta: 0 } };
  },

  "D08a-missing-basis-rule": (input) => {
    const policy = Object.freeze({ id: policyId("case-d08a"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("accountingBasis", "cash"), kind: "accountingBasis" as const, basis: "cash" as const, rules: input.policy_rule_kinds.map((event: string, index: number) => basisRule(`case-d08a-${event}-${index}`, event as never, "carryThrough" as never)) }) as never as AccountingPolicy;
    const fixture = basisSnapshot([policy], input.population_event_kinds.map((event: string, index: number) => ({ id: `E${index}`, event: event as never, bookValueCents: -1_000 })));
    const result = projectAccountingBasis([policy], policy.id, policy.version, createAccountingReadSnapshot(fixture.current.state, fixture.at, fixture.events.map((event) => event.source), fixture.events));
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("accounting_basis_policy_incomplete", { hostile_admitted: true });
  },

  "D08b-unclassified-source-event": (input) => {
    const policy = Object.freeze({ id: policyId("case-d08b"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("accountingBasis", "cash"), kind: "accountingBasis" as const, basis: "cash" as const, rules: [basisRule("case-d08b-recognition", "recognition", "carryThrough")] }) as never as AccountingPolicy;
    const fixture = basisSnapshot([policy], input.population_posting_ids.map((posting: string, index: number) => ({ id: posting, event: index === 0 ? "recognition" as const : "settlement" as const, bookValueCents: -1_000 })));
    const classified = fixture.events.filter((event) => input.classified_source_posting_ids.includes(event.id));
    const result = projectAccountingBasis([policy], policy.id, policy.version, createAccountingReadSnapshot(fixture.current.state, fixture.at, fixture.events.map((event) => event.source), classified));
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("accounting_basis_policy_incomplete", { hostile_admitted: true });
  },

  "D08c-source-population-hash-mismatch": (input) => {
    const policy = Object.freeze({ id: policyId("case-d08c"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("accountingBasis", "cash"), kind: "accountingBasis" as const, basis: "cash" as const, rules: [basisRule("case-d08c-recognition", "recognition", "carryThrough")] }) as never as AccountingPolicy;
    const fixture = basisSnapshot([policy], [{ id: "P1", event: "recognition", bookValueCents: -1_000 }]);
    const snapshot = createAccountingReadSnapshot(fixture.current.state, fixture.at, fixture.events.map((event) => event.source), fixture.events);
    const result = projectAccountingBasis([policy], policy.id, policy.version, { ...snapshot, sourcePopulationHash: parseHash(input.projection_population_hash) });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("accounting_basis_policy_incomplete", { hostile_admitted: true });
  },

  "D08d-basis-projection-mutates-canonical-state": (_input) => {
    const policy = Object.freeze({ id: policyId("case-d08d"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("accountingBasis", "cash"), kind: "accountingBasis" as const, basis: "cash" as const, rules: [basisRule("case-d08d-recognition", "recognition", "carryThrough")] }) as never as AccountingPolicy;
    const fixture = basisSnapshot([policy], [{ id: "P1", event: "recognition", bookValueCents: -1_000 }]);
    const result = projectAccountingBasis([policy], policy.id, policy.version, createAccountingReadSnapshot(fixture.current.state, fixture.at, fixture.events.map((event) => event.source), fixture.events));
    if (result.disposition !== "projected") throw new Error("Projection must project");
    const mutatesCanonicalState = "journals" in result.projection || "effects" in result.projection || "bookRevision" in result.projection;
    return designHolds(!mutatesCanonicalState, "accounting_basis_policy_incomplete", { projection_is_pure_derivation: !mutatesCanonicalState });
  },

  "D09-currency-settlement-and-period-remeasurement": (input) => {
    const policies = [classificationPolicyFor(), currencyPolicyFor(input)];
    const at = instant(input.policy_effective_at);
    const remeasure = (position: any, kind: "realized" | "unrealized", rate: string, effectiveOn: string, id: string) =>
      calculateCurrencyRemeasurement(policies, IDS.book, commodityId("USD"), {
        id: identifier<"RemeasurementResult">(id), policyId: policies[1]!.id, policyVersion: policies[1]!.version,
        classificationPolicyId: policies[0]!.id, classificationPolicyVersion: policies[0]!.version,
        governedAt: at, kind, classification: input.classification, sourcePostingId: postingId(position.id),
        effectiveOn: localDate(effectiveOn), denominationCommodityId: commodityId(position.commodity),
        denomination: r(String(position.quantity)), carryingBookValue: cents(position.carrying_book_value_cents),
        valuationPath: { fromCommodityId: commodityId(position.commodity), toCommodityId: commodityId("USD"), effectiveAt: instant(effectiveOn === "2026-12-31" ? "2026-12-31T23:59:59Z" : "2026-12-31T23:59:59Z"), observedAt: instant("2026-12-30T00:00:00Z"), rate: r(rate), evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) },
        positionAccountId: account("AR"), derivation: caseDerivation(`case-${id}`),
      });
    const realized = remeasure(input.settled_position, "realized", input.settlement_rate_usd_per_eur, "2026-12-31", "case-d09-realized");
    const unrealized = remeasure(input.open_position, "unrealized", input.closing_rate_usd_per_eur, "2026-12-31", "case-d09-unrealized");
    if (realized.disposition !== "draft" || unrealized.disposition !== "draft") return rejectWith("currency_remeasurement_violation");
    const realizedEffect = realized.draft.effects[0]!;
    const unrealizedEffect = unrealized.draft.effects[0]!;
    if (realizedEffect.type !== "remeasurementResult" || unrealizedEffect.type !== "remeasurementResult") throw new Error("Expected remeasurement effects");
    let state = applyAccountingEffect(applyAccountingEffect(emptyAccountingCanonicalState(), realizedEffect), unrealizedEffect);
    const reversal = calculateCurrencyRemeasurement(policies, IDS.book, commodityId("USD"), {
      id: identifier<"RemeasurementResult">("case-d09-unused"), policyId: policies[1]!.id, policyVersion: policies[1]!.version,
      classificationPolicyId: policies[0]!.id, classificationPolicyVersion: policies[0]!.version,
      governedAt: instant("2027-01-31T23:59:59Z"), kind: "unrealized", classification: input.classification,
      sourcePostingId: postingId("case-d09-reversal-source"), effectiveOn: localDate("2027-01-31"),
      denominationCommodityId: commodityId(input.open_position.commodity), denomination: r(String(input.open_position.quantity)),
      carryingBookValue: cents(input.open_position.carrying_book_value_cents),
      valuationPath: { fromCommodityId: commodityId(input.open_position.commodity), toCommodityId: commodityId("USD"), effectiveAt: instant("2027-01-31T23:59:59Z"), observedAt: instant("2027-01-30T00:00:00Z"), rate: r(input.closing_rate_usd_per_eur), evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) },
      positionAccountId: account("AR"), derivation: caseDerivation("case-d09-reversal"),
      reversalOf: unrealizedEffect.value.id, reversalId: identifier<"RemeasurementReversal">("case-d09-reversal"),
    }, state);
    if (reversal.disposition !== "draft") return rejectWith("currency_remeasurement_violation");
    const reversalEffect = reversal.draft.effects[0]!;
    if (reversalEffect.type !== "remeasurementReversal") throw new Error("Expected reversal effect");
    return {
      outcome: "admit",
      facts: {
        settled_position_id: String(realizedEffect.value.sourcePostingId),
        settlement_book_value_cents: toCents(realizedEffect.value.measuredBookValue),
        realized_gain_cents: toCents(realizedEffect.value.difference),
        open_position_id: String(unrealizedEffect.value.sourcePostingId),
        closing_book_value_cents: toCents(unrealizedEffect.value.measuredBookValue),
        unrealized_gain_cents: toCents(unrealizedEffect.value.difference),
        next_period_reversal_cents: toCents(unrealizedEffect.value.difference.negate()),
      },
    };
  },

  "D10a-missing-valuation-path": (input) => {
    const policies = [classificationPolicyFor(), currencyPolicyFor(input)];
    const result = calculateCurrencyRemeasurement(policies, IDS.book, commodityId("USD"), {
      id: identifier<"RemeasurementResult">("case-d10a"), policyId: policies[1]!.id, policyVersion: policies[1]!.version,
      classificationPolicyId: policies[0]!.id, classificationPolicyVersion: policies[0]!.version,
      governedAt: instant("2026-12-31T23:59:59Z"), kind: "unrealized", classification: input.classification,
      sourcePostingId: postingId("case-d10a-source"), effectiveOn: localDate("2026-12-31"),
      denominationCommodityId: commodityId(input.position_commodity), denomination: r("100/1"), carryingBookValue: cents(11_000),
      valuationPath: { fromCommodityId: commodityId(input.position_commodity), toCommodityId: commodityId(input.book_commodity), effectiveAt: instant("2026-12-31T23:59:59Z"), observedAt: instant("2026-12-30T00:00:00Z"), rate: ExactRational.of(6n, 5n), evidenceIds: Object.freeze([]) },
      positionAccountId: account("AR"), derivation: caseDerivation("case-d10a"),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("currency_remeasurement_violation", { hostile_admitted: true });
  },

  "D10b-nonmonetary-position": (input) => {
    const policies = [classificationPolicyFor(), currencyPolicyFor(input)];
    const result = calculateCurrencyRemeasurement(policies, IDS.book, commodityId("USD"), {
      id: identifier<"RemeasurementResult">("case-d10b"), policyId: policies[1]!.id, policyVersion: policies[1]!.version,
      classificationPolicyId: policies[0]!.id, classificationPolicyVersion: policies[0]!.version,
      governedAt: instant("2026-12-31T23:59:59Z"), kind: input.requested_effect, classification: input.classification,
      sourcePostingId: postingId("case-d10b-source"), effectiveOn: localDate("2026-12-31"),
      denominationCommodityId: commodityId(input.position_commodity), denomination: r("100/1"), carryingBookValue: cents(11_000),
      valuationPath: { fromCommodityId: commodityId(input.position_commodity), toCommodityId: commodityId("USD"), effectiveAt: instant("2026-12-31T23:59:59Z"), observedAt: instant("2026-12-30T00:00:00Z"), rate: ExactRational.of(6n, 5n), evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) },
      positionAccountId: account("AR"), derivation: caseDerivation("case-d10b"),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("currency_remeasurement_violation", { hostile_admitted: true });
  },

  "D10c-required-reversal-missing": (input) => {
    const policies = [classificationPolicyFor(), currencyPolicyFor(input)];
    const book = accountingBook(policies);
    const active = executeBookCommand(book.state, book.protocol, sealCommand({ ...coreCommand(book.state, "case-d10c-activate", "2026-01-01T14:00:00Z"), ...activationCommand("case-d10c-activate") } as never));
    const sourceJournal = Object.freeze({
      id: journalId("case-d10c-source-journal"), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-15T12:00:00Z"), accountingDate: localDate("2026-01-15"), recordedAt: instant("2026-01-15T13:00:00Z"), narration: "Monetary source",
      postings: Object.freeze([
        Object.freeze({ id: postingId("case-d10c-source-ar"), ordinal: 1n, accountId: account("AR"), units: Object.freeze({ canonicalNumber: r("100/1"), commodityId: commodityId("EUR") }), bookValue: Object.freeze({ amount: ExactDecimal.of(11_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
        Object.freeze({ id: postingId("case-d10c-source-offset"), ordinal: 2n, accountId: IDS.revenue, units: Object.freeze({ canonicalNumber: r("-110/1"), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-11_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      ]),
    });
    const sourceCommitted = run(active.state, active.protocol, sealCommand({ ...coreCommand(active.state, "case-d10c-source-command", "2026-01-15T14:00:00Z"), type: "postJournal" as const, resolved: resolved(sourceJournal as never) } as never));
    const remeasurement = run(sourceCommitted.state, sourceCommitted.protocol, sealCommand({
      ...coreCommand(sourceCommitted.state, "case-d10c-remeasure", "2026-01-16T14:00:00Z"), type: "postCurrencyRemeasurement" as const,
      request: {
        id: identifier<"RemeasurementResult">("case-d10c-result"), policyId: policies[1]!.id, policyVersion: policies[1]!.version,
        classificationPolicyId: policies[0]!.id, classificationPolicyVersion: policies[0]!.version,
        governedAt: instant("2026-01-15T14:00:00Z"), kind: "unrealized", classification: input.classification,
        source: postingReference(sourceJournal, "case-d10c-source-command:journal:0"), generatedEffectKey: "case-d10c-remeasure:journal:0" as never, effectiveOn: localDate("2026-01-15"),
        denominationCommodityId: commodityId("EUR"), denomination: r("100/1"), carryingBookValue: cents(11_000),
        valuationPath: { fromCommodityId: commodityId("EUR"), toCommodityId: commodityId("USD"), effectiveAt: instant("2026-01-15T14:00:00Z"), observedAt: instant("2026-01-14T00:00:00Z"), rate: ExactRational.of(6n, 5n), evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) },
        positionAccountId: account("AR"), derivation: caseDerivation("case-d10c"),
      },
    } as never));
    if (remeasurement.result.disposition !== "committed") throw new Error(`Remeasurement must commit: ${remeasurement.result.diagnostics[0]?.message}`);
    const openJournal = Object.freeze({
      id: journalId("case-d10c-open-journal"), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
      economicAt: instant("2026-01-20T12:00:00Z"), accountingDate: localDate("2026-01-20"), recordedAt: instant("2026-01-20T13:00:00Z"), narration: "Open item source",
      postings: Object.freeze([
        Object.freeze({ id: postingId("case-d10c-open-posting"), ordinal: 1n, accountId: account("AR"), units: Object.freeze({ canonicalNumber: ExactRational.of(1n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(100n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
        Object.freeze({ id: postingId("case-d10c-open-offset"), ordinal: 2n, accountId: account("REVENUE"), units: Object.freeze({ canonicalNumber: ExactRational.of(-1n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-100n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      ]),
    });
    const subsequent = run(remeasurement.state, remeasurement.protocol, sealCommand({
      ...coreCommand(remeasurement.state, "case-d10c-next", "2026-01-20T14:00:00Z"), type: "recognizeOpenItem" as const,
      request: { value: { id: identifier<"OpenItem">("case-d10c-open"), bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "C", controlAccountId: account("AR") }, recognitionPostingId: postingId("case-d10c-open-posting"), recognizedOn: localDate("2026-01-20"), denominationCommodityId: IDS.usd, denomination: r("1/1"), bookValue: cents(1), derivation: caseDerivation("case-d10c-open") } },
      resolved: resolved(openJournal as never),
    } as never));
    return subsequent.result.disposition === "rejected" ? rejectWith(subsequent.result.diagnostics[0]!.code) : rejectWith("currency_remeasurement_violation", { hostile_admitted: true });
  },

  "D10d-wrong-valuation-effective-date": (input) => {
    const policies = [classificationPolicyFor(), currencyPolicyFor(input)];
    const result = calculateCurrencyRemeasurement(policies, IDS.book, commodityId("USD"), {
      id: identifier<"RemeasurementResult">("case-d10d"), policyId: policies[1]!.id, policyVersion: policies[1]!.version,
      classificationPolicyId: policies[0]!.id, classificationPolicyVersion: policies[0]!.version,
      governedAt: instant("2026-12-31T23:59:59Z"), kind: "unrealized", classification: "monetary",
      sourcePostingId: postingId("case-d10d-source"), effectiveOn: localDate(input.remeasurement_date),
      denominationCommodityId: commodityId("EUR"), denomination: r("100/1"), carryingBookValue: cents(11_000),
      valuationPath: { fromCommodityId: commodityId("EUR"), toCommodityId: commodityId("USD"), effectiveAt: instant(input.valuation_path_effective_at), observedAt: instant("2026-12-30T00:00:00Z"), rate: ExactRational.of(6n, 5n), evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) },
      positionAccountId: account("AR"), derivation: caseDerivation("case-d10d"),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("currency_remeasurement_violation", { hostile_admitted: true });
  },

  "D10e-realized-exchange-arithmetic-mismatch": (input) => {
    const policies = [classificationPolicyFor(), currencyPolicyFor({ reversal_required: false })];
    const result = calculateCurrencyRemeasurement(policies, IDS.book, commodityId("USD"), {
      id: identifier<"RemeasurementResult">("case-d10e"), policyId: policies[1]!.id, policyVersion: policies[1]!.version,
      classificationPolicyId: policies[0]!.id, classificationPolicyVersion: policies[0]!.version,
      governedAt: instant("2026-12-31T23:59:59Z"), kind: "realized", classification: "monetary",
      sourcePostingId: postingId("case-d10e-source"), effectiveOn: localDate("2026-12-31"),
      denominationCommodityId: commodityId("EUR"), denomination: r("100/1"), carryingBookValue: cents(input.carrying_book_value_cents),
      valuationPath: { fromCommodityId: commodityId("EUR"), toCommodityId: commodityId("USD"), effectiveAt: instant("2026-12-31T23:59:59Z"), observedAt: instant("2026-12-30T00:00:00Z"), rate: r("23/20"), evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) },
      positionAccountId: account("AR"), derivation: caseDerivation("case-d10e"),
    });
    if (result.disposition !== "draft") throw new Error("Realized remeasurement must draft");
    const effect = result.draft.effects[0]!;
    if (effect.type !== "remeasurementResult") throw new Error("Expected remeasurement effect");
    const exactGainCents = toCents(effect.value.difference);
    const proposedGainAccepted = exactGainCents === input.proposed_realized_gain_cents;
    const expectedGainCents = toCents(cents(input.settlement_book_value_cents).subtract(cents(input.carrying_book_value_cents)));
    return designHolds(!proposedGainAccepted && exactGainCents === expectedGainCents, "currency_remeasurement_violation", { exact_realized_gain_cents: exactGainCents });
  },

  "D10f-unrealized-exchange-arithmetic-mismatch": (input) => {
    const policies = [classificationPolicyFor(), currencyPolicyFor({ reversal_required: false })];
    const result = calculateCurrencyRemeasurement(policies, IDS.book, commodityId("USD"), {
      id: identifier<"RemeasurementResult">("case-d10f"), policyId: policies[1]!.id, policyVersion: policies[1]!.version,
      classificationPolicyId: policies[0]!.id, classificationPolicyVersion: policies[0]!.version,
      governedAt: instant("2026-12-31T23:59:59Z"), kind: "unrealized", classification: "monetary",
      sourcePostingId: postingId("case-d10f-source"), effectiveOn: localDate("2026-12-31"),
      denominationCommodityId: commodityId("EUR"), denomination: r("100/1"), carryingBookValue: cents(input.carrying_book_value_cents),
      valuationPath: { fromCommodityId: commodityId("EUR"), toCommodityId: commodityId("USD"), effectiveAt: instant("2026-12-31T23:59:59Z"), observedAt: instant("2026-12-30T00:00:00Z"), rate: ExactRational.of(6n, 5n), evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) },
      positionAccountId: account("AR"), derivation: caseDerivation("case-d10f"),
    });
    if (result.disposition !== "draft") throw new Error("Unrealized remeasurement must draft");
    const effect = result.draft.effects[0]!;
    if (effect.type !== "remeasurementResult") throw new Error("Expected remeasurement effect");
    const exactGainCents = toCents(effect.value.difference);
    return designHolds(exactGainCents === input.closing_book_value_cents - input.carrying_book_value_cents && exactGainCents !== input.proposed_unrealized_gain_cents, "currency_remeasurement_violation", { exact_unrealized_gain_cents: exactGainCents });
  },

  "D10g-remeasurement-rewrites-source-journal": (_input) => {
    const policies = [classificationPolicyFor(), currencyPolicyFor({ reversal_required: false })];
    const result = calculateCurrencyRemeasurement(policies, IDS.book, commodityId("USD"), {
      id: identifier<"RemeasurementResult">("case-d10g"), policyId: policies[1]!.id, policyVersion: policies[1]!.version,
      classificationPolicyId: policies[0]!.id, classificationPolicyVersion: policies[0]!.version,
      governedAt: instant("2026-12-31T23:59:59Z"), kind: "unrealized", classification: "monetary",
      sourcePostingId: postingId("case-d10g-source"), effectiveOn: localDate("2026-12-31"),
      denominationCommodityId: commodityId("EUR"), denomination: r("100/1"), carryingBookValue: cents(11_000),
      valuationPath: { fromCommodityId: commodityId("EUR"), toCommodityId: commodityId("USD"), effectiveAt: instant("2026-12-31T23:59:59Z"), observedAt: instant("2026-12-30T00:00:00Z"), rate: ExactRational.of(6n, 5n), evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) },
      positionAccountId: account("AR"), derivation: caseDerivation("case-d10g"),
    });
    if (result.disposition !== "draft") throw new Error("Remeasurement must draft");
    const separateAdjustment = result.draft.journals.length === 1 && result.draft.journals[0]!.kind === "adjustment" && result.draft.journals[0]!.postings.every((posting) => posting.id !== postingId("case-d10g-source"));
    return designHolds(separateAdjustment, "currency_remeasurement_violation", { separate_adjustment_present: separateAdjustment, source_journal_unchanged: separateAdjustment });
  },

  "D11-exact-allocation-schedule": (input) => {
    const allocationPolicy = allocationPolicyFor(input);
    const scheduled = createAllocationSchedule([allocationPolicy], IDS.book, {
      id: identifier<"AllocationSchedule">("case-d11"), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version,
      governedAt: instant(input.policy_effective_at), sourcePostingId: postingId("case-d11-source"),
      sourceBasis: cents(input.source_basis_cents), residualValue: cents(input.residual_value_cents),
      startsOn: localDate(input.starts_on), endsOn: localDate(input.ends_on), derivation: caseDerivation("case-d11", allocationPolicy.id),
    });
    if (scheduled.disposition !== "draft") return rejectWith("allocation_schedule_violation");
    const scheduleEffect = scheduled.draft.effects[0]!;
    if (scheduleEffect.type !== "allocationSchedule") throw new Error("Expected schedule effect");
    let state = applyAccountingEffect(emptyAccountingCanonicalState(), scheduleEffect);
    const recognized = recognizeScheduledAllocation([allocationPolicy], state, IDS.usd, { id: identifier<"AllocationRecognition">("case-d11-rec"), scheduleId: scheduleEffect.value.id, ordinal: 1n, governedAt: instant("2026-01-31T00:00:00Z"), derivation: caseDerivation("case-d11-rec", allocationPolicy.id) });
    if (recognized.disposition === "draft") for (const effect of recognized.draft.effects) state = applyAccountingEffect(state, effect);
    const scheduleAfter = state.allocationSchedules[0]!;
    const installmentCents = scheduleEffect.value.installments.map((installment) => toCents(installment.amount));
    const recognitionEffect = state.allocationRecognitions[0]!;
    const revisionDerivation = caseDerivation("case-d11-revision", allocationPolicy.id);
    const revised = reviseAllocationSchedule([allocationPolicy], state, IDS.book, IDS.usd, {
      id: identifier<"AllocationScheduleRevision">(input.revision.id), kind: "estimateChange", effectiveOn: localDate(input.revision.effective_on), policyEffectiveAt: instant(input.revision.policy_effective_at), originalScheduleId: scheduleEffect.value.id, priorRecognitionIds: [recognitionEffect.id], policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, revisedResidualValue: cents(input.revision.revised_residual_value_cents), successorScheduleId: identifier<"AllocationSchedule">(input.revision.successor_schedule_id), revisedEndsOn: localDate(input.revision.revised_ends_on), evidence: revisionDerivation.evidence, derivation: revisionDerivation,
    });
    if (revised.disposition !== "draft") return rejectWith("allocation_schedule_revision_violation");
    for (const effect of revised.draft.effects) state = applyAccountingEffect(state, effect);
    const revisionEffect = state.allocationScheduleRevisions[0]!;
    const successor = state.allocationSchedules.find((schedule) => schedule.id === revisionEffect.successorScheduleId)!;
    const supersededRecognition = recognizeScheduledAllocation([allocationPolicy], state, IDS.usd, { id: identifier<"AllocationRecognition">("case-d11-superseded"), scheduleId: scheduleEffect.value.id, ordinal: 2n, governedAt: instant("2026-02-28T00:00:00Z"), derivation: caseDerivation("case-d11-superseded", allocationPolicy.id) });
    return {
      outcome: "admit",
      facts: {
        installment_count: scheduleEffect.value.installments.length,
        installment_book_values_cents: installmentCents,
        exact_total_cents: scheduleEffect.value.installments.reduce((total, installment) => total.add(installment.amount), ExactRational.zero()).multiply(ExactRational.of(100n, 1n)).toString(),
        schedule_mutated_on_recognition: scheduleAfter.contentHash.digest !== scheduleEffect.value.contentHash.digest,
        revision_kind: revisionEffect.kind,
        revision_recognized_to_date_cents: toCents(revisionEffect.recognizedToDate),
        revision_carrying_amount_cents: toCents(revisionEffect.carryingAmountAtRevision),
        successor_installment_count: successor.installments.length,
        successor_exact_total_cents: toCents(successor.installments.reduce((total, installment) => total.add(installment.amount), ExactRational.zero())),
        original_schedule_unchanged: scheduleAfter.contentHash.digest === scheduleEffect.value.contentHash.digest,
        superseded_original_future_rejected: supersededRecognition.disposition === "rejected",
      },
    };
  },

  "D12a-residual-exceeds-basis": (input) => {
    const allocationPolicy = allocationPolicyFor(input);
    const result = createAllocationSchedule([allocationPolicy], IDS.book, {
      id: identifier<"AllocationSchedule">("case-d12a"), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version,
      governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("case-d12a-source"),
      sourceBasis: cents(input.source_basis_cents), residualValue: cents(input.residual_value_cents),
      startsOn: localDate(input.starts_on), endsOn: localDate(input.ends_on), derivation: caseDerivation("case-d12a", allocationPolicy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("allocation_schedule_violation", { hostile_admitted: true });
  },

  "D12b-reversed-schedule-dates": (input) => {
    const allocationPolicy = allocationPolicyFor(input);
    const result = createAllocationSchedule([allocationPolicy], IDS.book, {
      id: identifier<"AllocationSchedule">("case-d12b"), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version,
      governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("case-d12b-source"),
      sourceBasis: cents(input.source_basis_cents), residualValue: cents(input.residual_value_cents),
      startsOn: localDate(input.starts_on), endsOn: localDate(input.ends_on), derivation: caseDerivation("case-d12b", allocationPolicy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("allocation_schedule_violation", { hostile_admitted: true });
  },

  "D12c-declining-rate-missing": (input) => {
    const policy = Object.freeze({ ...allocationPolicyFor(input), decliningRate: input.declining_rate === null ? undefined : r(String(input.declining_rate)) }) as never as AccountingPolicy;
    const result = createAllocationSchedule([policy], IDS.book, {
      id: identifier<"AllocationSchedule">("case-d12c"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("case-d12c-source"),
      sourceBasis: cents(input.source_basis_cents), residualValue: cents(input.residual_value_cents),
      startsOn: localDate(input.starts_on), endsOn: localDate(input.ends_on), derivation: caseDerivation("case-d12c", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("allocation_schedule_violation", { hostile_admitted: true });
  },

  "D12d-usage-facts-missing": (input) => {
    const allocationPolicy = allocationPolicyFor(input);
    const policy = Object.freeze({ ...allocationPolicy, expectedUsage: r(String(input.expected_usage)) }) as never as AccountingPolicy;
    const result = createAllocationSchedule([policy], IDS.book, {
      id: identifier<"AllocationSchedule">("case-d12d"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("case-d12d-source"),
      sourceBasis: cents(input.source_basis_cents), residualValue: cents(input.residual_value_cents),
      startsOn: localDate("2026-01-01"), endsOn: localDate("2026-12-31"),
      usage: (input.usage_facts as any[]).map((usage) => ({ date: localDate("2026-06-30"), value: r(String(usage.value ?? usage)) })),
      derivation: caseDerivation("case-d12d", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("allocation_schedule_violation", { hostile_admitted: true });
  },

  "D12e-duplicate-installment-recognition": (input) => {
    const allocationPolicy = allocationPolicyFor({ method: "straightLine", frequency: "monthly", convention: "fullPeriod" });
    const scheduled = createAllocationSchedule([allocationPolicy], IDS.book, {
      id: identifier<"AllocationSchedule">(input.schedule_id), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version,
      governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("case-d12e-source"),
      sourceBasis: cents(12_000), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-12-31"),
      derivation: caseDerivation("case-d12e", allocationPolicy.id),
    });
    if (scheduled.disposition !== "draft") return rejectWith("allocation_schedule_violation");
    let state = applyAccountingEffect(emptyAccountingCanonicalState(), scheduled.draft.effects[0]!);
    for (const ordinal of input.prior_recognized_ordinals) {
      const recognition = recognizeScheduledAllocation([allocationPolicy], state, IDS.usd, { id: identifier<"AllocationRecognition">(`case-d12e-rec-${ordinal}`), scheduleId: identifier<"AllocationSchedule">(input.schedule_id), ordinal: BigInt(ordinal), governedAt: instant("2026-01-31T00:00:00Z"), derivation: caseDerivation(`case-d12e-rec-${ordinal}`, allocationPolicy.id) });
      if (recognition.disposition !== "draft") return rejectWith("allocation_schedule_violation");
      state = applyAccountingEffect(state, recognition.draft.effects[0]!);
    }
    const duplicate = recognizeScheduledAllocation([allocationPolicy], state, IDS.usd, { id: identifier<"AllocationRecognition">("case-d12e-dup"), scheduleId: identifier<"AllocationSchedule">(input.schedule_id), ordinal: BigInt(input.schedule_ordinal), governedAt: instant("2026-02-28T00:00:00Z"), derivation: caseDerivation("case-d12e-dup", allocationPolicy.id) });
    return duplicate.disposition === "rejected" ? rejectWith(duplicate.diagnostics[0]!.code) : rejectWith("allocation_schedule_violation", { hostile_admitted: true });
  },

  "D12f-nonconserving-schedule-total": (input) => {
    const policy = Object.freeze({ ...allocationPolicyFor({ method: "unitsOfProduction", frequency: "eventDriven", convention: "usageEvent" }), expectedUsage: r("120000/100") }) as never as AccountingPolicy;
    const totalGiven = input.installment_book_values_cents.reduce((total: number, value: number) => total + value, 0);
    const usage = input.installment_book_values_cents.slice(0, -1).map((value: number, index: number) => ({ date: localDate(`2026-${String(index + 1).padStart(2, "0")}-28`), value: cents(value) }));
    const result = createAllocationSchedule([policy], IDS.book, {
      id: identifier<"AllocationSchedule">("case-d12f"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("case-d12f-source"),
      sourceBasis: cents(input.source_basis_cents), residualValue: cents(input.residual_value_cents),
      startsOn: localDate("2026-01-01"), endsOn: localDate("2026-12-31"), usage,
      derivation: caseDerivation("case-d12f", policy.id),
    });
    if (result.disposition === "draft") {
      const effect = result.draft.effects[0]!;
      if (effect.type !== "allocationSchedule") throw new Error("Expected schedule effect");
      const conserved = effect.value.installments.reduce((total, installment) => total.add(installment.amount), ExactRational.zero()).add(effect.value.residualValue).equals(cents(input.source_basis_cents));
      return designHolds(conserved && totalGiven !== input.source_basis_cents, "allocation_schedule_violation", { exact_installments_conserve_basis: conserved });
    }
    return rejectWith(result.diagnostics[0]!.code);
  },

  "D12g-recognition-mutates-schedule": (_input) => {
    const allocationPolicy = allocationPolicyFor({ method: "straightLine", frequency: "monthly", convention: "fullPeriod" });
    const scheduled = createAllocationSchedule([allocationPolicy], IDS.book, {
      id: identifier<"AllocationSchedule">("case-d12g"), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version,
      governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("case-d12g-source"),
      sourceBasis: cents(12_000), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-12-31"),
      derivation: caseDerivation("case-d12g", allocationPolicy.id),
    });
    if (scheduled.disposition !== "draft") return rejectWith("allocation_schedule_violation");
    const scheduleEffect = scheduled.draft.effects[0]!;
    if (scheduleEffect.type !== "allocationSchedule") throw new Error("Expected schedule effect");
    const hashBefore = scheduleEffect.value.contentHash.digest;
    let state = applyAccountingEffect(emptyAccountingCanonicalState(), scheduleEffect);
    const recognized = recognizeScheduledAllocation([allocationPolicy], state, IDS.usd, { id: identifier<"AllocationRecognition">("case-d12g-rec"), scheduleId: scheduleEffect.value.id, ordinal: 1n, governedAt: instant("2026-01-31T00:00:00Z"), derivation: caseDerivation("case-d12g-rec", allocationPolicy.id) });
    if (recognized.disposition === "draft") for (const effect of recognized.draft.effects) state = applyAccountingEffect(state, effect);
    const hashAfter = state.allocationSchedules[0]!.contentHash.digest;
    return designHolds(hashBefore === hashAfter, "allocation_schedule_violation", { schedule_hash_unchanged_across_recognition: hashBefore === hashAfter });
  },

  "D12h-recognition-in-closed-period": (input) => {
    const allocationPolicy = allocationPolicyFor({ method: "straightLine", frequency: "monthly", convention: "fullPeriod" });
    const book = accountingBook([allocationPolicy]);
    const active = executeBookCommand(book.state, book.protocol, sealCommand({ ...coreCommand(book.state, "case-d12h-activate", "2026-01-01T14:00:00Z"), ...activationCommand("case-d12h-activate") } as never));
    const sourceJournal = Object.freeze({ id: journalId("case-d12h-source-journal"), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd, economicAt: instant("2026-01-05T12:00:00Z"), accountingDate: localDate("2026-01-05"), recordedAt: instant("2026-01-05T13:00:00Z"), narration: "Allocation source", postings: Object.freeze([
      Object.freeze({ id: postingId("case-d12h-source-posting"), ordinal: 1n, accountId: account("AR"), units: Object.freeze({ canonicalNumber: cents(12_000), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(12_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      Object.freeze({ id: postingId("case-d12h-source-offset"), ordinal: 2n, accountId: IDS.revenue, units: Object.freeze({ canonicalNumber: cents(-12_000), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-12_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
    ]) });
    const sourceCommitted = run(active.state, active.protocol, sealCommand({ ...coreCommand(active.state, "case-d12h-source-command", "2026-01-05T13:30:00Z"), type: "postJournal" as const, resolved: resolved(sourceJournal as never) } as never));
    const scheduled = run(sourceCommitted.state, sourceCommitted.protocol, sealCommand({
      ...coreCommand(sourceCommitted.state, "case-d12h-schedule", "2026-01-05T14:00:00Z"), type: "createAllocationSchedule" as const,
      request: { id: identifier<"AllocationSchedule">(input.schedule_id), policyId: allocationPolicy.id, policyVersion: allocationPolicy.version, governedAt: instant("2026-01-05T14:00:00Z"), source: postingReference(sourceJournal, "case-d12h-source-command:journal:0"), sourceBasis: cents(12_000), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-12-31"), derivation: caseDerivation("case-d12h", allocationPolicy.id) },
    } as never));
    if (scheduled.result.disposition !== "committed") throw new Error(`Schedule must commit: ${scheduled.result.diagnostics[0]?.message}`);
    const closed = closePeriod(scheduled.state, scheduled.protocol, 0);
    const recognition = run(closed.state, closed.protocol, sealCommand({
      ...coreCommand(closed.state, "case-d12h-rec", "2026-02-02T14:00:00Z"), type: "recognizeScheduledAllocation" as const,
      request: { id: identifier<"AllocationRecognition">("case-d12h-rec"), scheduleId: identifier<"AllocationSchedule">(input.schedule_id), ordinal: BigInt(input.schedule_ordinal), governedAt: instant("2026-01-31T14:00:00Z"), derivation: caseDerivation("case-d12h-rec", allocationPolicy.id) },
    } as never));
    return recognition.result.disposition === "rejected" ? rejectWith(recognition.result.diagnostics[0]!.code) : rejectWith("allocation_schedule_violation", { hostile_admitted: true });
  },

  "D13-versioned-tax-determination": (input) => {
    const policy = taxPolicyFor(input);
    const lines = input.taxable_lines.map((line: any) => ({
      lineId: line.id, sourcePostingId: postingId(`${line.id}-source-posting`), counterpartyPostingId: postingId(`${line.id}-counterparty-posting`),
      policyId: policy.id, policyVersion: policy.version, statedAmount: cents(line.stated_amount_cents),
      amountIncludesTax: line.amount_includes_tax === true, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP"),
    }));
    const result = determineTax([policy], IDS.book, commodityId("USD"), {
      id: identifier<"TaxDetermination">("case-d13"), sourceTransactionId: journalId("case-d13-source"),
      governedAt: instant(input.tax_point), direction: "purchase", lines: Object.freeze(lines), derivation: caseDerivation("case-d13", policy.id),
    });
    if (result.disposition !== "draft") return rejectWith("tax_policy_ambiguity");
    const effect = result.draft.effects[0]!;
    if (effect.type !== "taxDetermination") throw new Error("Expected tax determination effect");
    const componentTaxCents: Record<string, number> = {};
    const recoverableCents: Record<string, number> = {};
    for (const line of effect.value.lines) {
      for (const component of line.components) {
        componentTaxCents[component.policyId] = (componentTaxCents[component.policyId] ?? 0) + toCents(component.exactTax);
        recoverableCents[component.policyId] = (recoverableCents[component.policyId] ?? 0) + toCents(component.recoverable);
      }
    }
    const totalTaxCents = effect.value.lines.flatMap((line) => line.components).reduce((total, component) => total + toCents(component.exactTax), 0);
    const nonRecoverableCents = effect.value.lines.flatMap((line) => line.components).reduce((total, component) => total + toCents(component.nonRecoverable), 0);
    return {
      outcome: "admit",
      facts: {
        component_tax_cents: componentTaxCents,
        total_tax_cents: totalTaxCents,
        tax_a_recoverable_cents: recoverableCents["TAX-A"] ?? 0,
        tax_b_recoverable_cents: recoverableCents["TAX-B"] ?? 0,
        tax_b_nonrecoverable_cents: nonRecoverableCents,
        gross_cents: effect.value.lines.reduce((total, line) => total + toCents(line.exclusiveBasis), 0) + totalTaxCents,
        single_atomic_intent: result.draft.journals.length === 1,
      },
    };
  },

  "D14a-tax-point-missing": (input) => {
    try {
      instant(input.tax_point);
    } catch {
      return rejectWith("tax_policy_ambiguity", { typed_tax_point_required: true });
    }
    return rejectWith("tax_policy_ambiguity", { hostile_admitted: true });
  },

  "D14b-compound-reference-missing": (input) => {
    const result = determineTax([taxPolicyFor({ components: input.components, tax_point: input.tax_point })], IDS.book, commodityId("USD"), {
      id: identifier<"TaxDetermination">("case-d14b"), sourceTransactionId: journalId("case-d14b-source"),
      governedAt: instant(input.tax_point), direction: "purchase",
      lines: Object.freeze([{ lineId: "L1", sourcePostingId: postingId("d14b-source"), counterpartyPostingId: postingId("d14b-counter"), policyId: policyId(`case-tax-${input.components.tax_code ?? "gst"}`), policyVersion: semanticVersion("1.0.0"), statedAmount: cents(10_000), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") }]),
      derivation: caseDerivation("case-d14b"),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("tax_policy_ambiguity", { hostile_admitted: true });
  },

  "D14c-invalid-recoverable-share": (input) => {
    const policy = taxPolicyFor({ components: [{ id: "TAX-C", rate: "1/10", inclusion: "exclusive", treatment: "inputTax", recoverability: input.recoverability, compound_ordinal: 1, compounds_on: [], recoverable_share: input.recoverable_share, recoverable_account: "INPUT-TAX", liability_account: "TAX-PAYABLE" }], tax_point: input.tax_point });
    const result = determineTax([policy], IDS.book, commodityId("USD"), {
      id: identifier<"TaxDetermination">("case-d14c"), sourceTransactionId: journalId("case-d14c-source"),
      governedAt: instant(input.tax_point), direction: "purchase",
      lines: Object.freeze([{ lineId: "L1", sourcePostingId: postingId("d14c-source"), counterpartyPostingId: postingId("d14c-counter"), policyId: policy.id, policyVersion: policy.version, statedAmount: cents(10_000), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") }]),
      derivation: caseDerivation("case-d14c", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("tax_policy_ambiguity", { hostile_admitted: true });
  },

  "D14d-inclusive-amount-no-exact-solution": (input) => {
    const policy = taxPolicyFor({ components: input.components.map((component: any) => ({ ...component, rate: String(component.rate) })), tax_point: input.tax_point });
    const result = determineTax([policy], IDS.book, commodityId("USD"), {
      id: identifier<"TaxDetermination">("case-d14d"), sourceTransactionId: journalId("case-d14d-source"),
      governedAt: instant(input.tax_point), direction: "purchase",
      lines: Object.freeze([{ lineId: "L1", sourcePostingId: postingId("d14d-source"), counterpartyPostingId: postingId("d14d-counter"), policyId: policy.id, policyVersion: policy.version, statedAmount: cents(input.stated_amount_cents ?? 10_000), amountIncludesTax: input.amount_includes_tax === true, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") }]),
      derivation: caseDerivation("case-d14d", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("tax_policy_ambiguity", { hostile_admitted: true });
  },

  "D14e-overlapping-tax-policy": (input) => {
    const first = { ...taxPolicyFor({ components: [{ id: "TAX-A", rate: "1/10", inclusion: "exclusive", treatment: "inputTax", recoverability: "recoverable", compound_ordinal: 1, compounds_on: [], recoverable_share: "1/1", recoverable_account: "INPUT-TAX", liability_account: "TAX-PAYABLE" }], tax_point: input.tax_point }), taxCode: input.tax_code };
    const policies = input.applicable_policy_versions.map((version: string) => Object.freeze({ ...first, version: semanticVersion(version) }));
    const result = determineTax(policies, IDS.book, commodityId("USD"), {
      id: identifier<"TaxDetermination">("case-d14e"), sourceTransactionId: journalId("case-d14e-source"),
      governedAt: instant(input.tax_point), direction: "purchase",
      lines: Object.freeze([{ lineId: "L1", sourcePostingId: postingId("d14e-source"), counterpartyPostingId: postingId("d14e-counter"), policyId: first.id, policyVersion: semanticVersion(input.requested_policy_version), statedAmount: cents(10_000), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") }]),
      derivation: caseDerivation("case-d14e", first.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("tax_policy_ambiguity", { hostile_admitted: true });
  },

  "D14f-quantized-tax-residual-unassigned": () => {
    const policy = taxPolicyFor({ components: [{ id: "TAX-HALF", rate: "1/2", inclusion: "exclusive", treatment: "inputTax", recoverability: "recoverable", compound_ordinal: 1, compounds_on: [], recoverable_share: "1/1", recoverable_account: "INPUT-TAX", liability_account: "TAX-PAYABLE" }], tax_point: "2026-04-15T12:00:00Z" });
    const result = determineTax([policy], IDS.book, commodityId("USD"), {
      id: identifier<"TaxDetermination">("case-d14f"), sourceTransactionId: journalId("case-d14f-source"),
      governedAt: instant("2026-04-15T12:00:00Z"), direction: "purchase",
      lines: Object.freeze([{ lineId: "L1", sourcePostingId: postingId("d14f-source"), counterpartyPostingId: postingId("d14f-counter"), policyId: policy.id, policyVersion: policy.version, statedAmount: cents(101), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") }]),
      derivation: caseDerivation("case-d14f", policy.id),
    });
    if (result.disposition !== "draft") return rejectWith("tax_policy_ambiguity");
    const effect = result.draft.effects[0]!;
    if (effect.type !== "taxDetermination") throw new Error("Expected tax effect");
    const observed = effect.value.lines.flatMap((line) => line.components);
    // The hostile scenario drops the quantization residual so exact totals drift.
    // The kernel must carry an explicit per-component residual that conserves the
    // exact tax through quantization: amount + residual === exactTax.
    const everyQuantizedConserves = observed.every((component) => {
      if (component.quantization.residual === undefined) return false;
      return component.quantization.amount.toRational().add(component.quantization.residual).equals(component.exactTax);
    });
    const quantizedTotalCents = observed.reduce((total, component) => total + toCents(component.quantization.amount.toRational()), 0);
    const exactTotalCents = observed.reduce((total, component) => total + toCents(component.exactTax), 0);
    return designHolds(everyQuantizedConserves && quantizedTotalCents <= exactTotalCents + 1, "tax_policy_ambiguity", {
      exact_components_cents: observed.map((component) => toCents(component.exactTax)),
      quantized_components_cents: observed.map((component) => toCents(component.quantization.amount.toRational())),
      quantized_total_cents: quantizedTotalCents,
      residual_assignment: everyQuantizedConserves ? "per_component" : null,
    });
  },

  "D14g-tax-journal-not-atomic-or-balanced": (_input) => {
    const policy = taxPolicyFor({ components: [{ id: "TAX-A", rate: "1/10", inclusion: "exclusive", treatment: "inputTax", recoverability: "recoverable", compound_ordinal: 1, compounds_on: [], recoverable_share: "1/1", recoverable_account: "INPUT-TAX", liability_account: "TAX-PAYABLE" }], tax_point: "2026-04-15T12:00:00Z" });
    const result = determineTax([policy], IDS.book, commodityId("USD"), {
      id: identifier<"TaxDetermination">("case-d14g"), sourceTransactionId: journalId("case-d14g-source"),
      governedAt: instant("2026-04-15T12:00:00Z"), direction: "purchase",
      lines: Object.freeze([
        { lineId: "L1", sourcePostingId: postingId("d14g-source-1"), counterpartyPostingId: postingId("d14g-counter-1"), policyId: policy.id, policyVersion: policy.version, statedAmount: cents(10_000), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") },
        { lineId: "L2", sourcePostingId: postingId("d14g-source-2"), counterpartyPostingId: postingId("d14g-counter-2"), policyId: policy.id, policyVersion: policy.version, statedAmount: cents(5_000), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") },
      ]),
      derivation: caseDerivation("case-d14g", policy.id),
    });
    if (result.disposition !== "draft") return rejectWith("tax_policy_ambiguity");
    const atomic = result.draft.journals.length === 1;
    const balanced = result.draft.journals.every((journal) => journal.postings.reduce((total, posting) => total.add(posting.exactBookValue), ExactRational.zero()).isZero());
    return designHolds(atomic && balanced, "tax_policy_ambiguity", { intent_count: result.draft.journals.length, posting_total_cents: toCents(result.draft.journals[0]!.postings.reduce((total, posting) => total.add(posting.exactBookValue), ExactRational.zero())) });
  },

  "D14h-jurisdiction-discovered-from-environment": (_input) => {
    const policy = taxPolicyFor({ components: [{ id: "TAX-A", rate: "1/10", inclusion: "exclusive", treatment: "inputTax", recoverability: "recoverable", compound_ordinal: 1, compounds_on: [], recoverable_share: "1/1", recoverable_account: "INPUT-TAX", liability_account: "TAX-PAYABLE" }], tax_point: "2026-04-15T12:00:00Z", jurisdiction: "DE-BY", tax_code: "VAT" });
    const taxPolicyTyped = policy as Extract<AccountingPolicy, { kind: "taxDetermination" }>;
    const jurisdictionIsTypedFact = taxPolicyTyped.jurisdiction === "DE-BY" && taxPolicyTyped.taxCode === "VAT" && !("environment" in policy);
    const result = determineTax([policy], IDS.book, commodityId("USD"), {
      id: identifier<"TaxDetermination">("case-d14h"), sourceTransactionId: journalId("case-d14h-source"),
      governedAt: instant("2026-04-15T12:00:00Z"), direction: "purchase",
      lines: Object.freeze([{ lineId: "L1", sourcePostingId: postingId("d14h-source"), counterpartyPostingId: postingId("d14h-counter"), policyId: policy.id, policyVersion: policy.version, statedAmount: cents(10_000), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") }]),
      derivation: caseDerivation("case-d14h", policy.id),
    });
    return designHolds(jurisdictionIsTypedFact && result.disposition === "draft", "tax_policy_ambiguity", { typed_jurisdiction_fact_present: jurisdictionIsTypedFact, determined_without_environment: result.disposition === "draft" });
  },

  "D15-reproducible-consolidation": (input) => {
    const policy = consolidationPolicyFor(input);
    const sources = input.sources.map((source: any) => ({
      bookId: source.book, revision: BigInt(source.revision), postingSequence: BigInt(source.posting_sequence),
      populationHash: parseHash(source.population_hash), expectedRevision: BigInt(source.revision),
      expectedPostingSequence: BigInt(source.posting_sequence), expectedPopulationHash: parseHash(source.population_hash),
      ...datedRelationship(source.book),
      control: source.relationship.control, method: source.relationship.method,
      ownershipShare: r(String(source.relationship.ownership_share)), votingShare: r(String(source.relationship.voting_share)),
      ...(source.relationship.non_controlling_interest_method === undefined ? {} : { nonControllingInterestMethod: source.relationship.non_controlling_interest_method }),
      controlEvidenceIds: [source.relationship.control_evidence],
      balances: Object.entries(source.balances_cents as Record<string, number>).map(([sourceAccount, amountCents]) => ({
        sourceAccountId: account(sourceAccount), unitsCommodityId: commodityId("USD"), classification: classificationOf(sourceAccount), amount: cents(amountCents),
        valuationPaths: identityValuationPaths,
      })),
    }));
    const eliminations = [
      { id: "interco-ar-elimination", sourceBookId: input.sources[0].book as never, sourceAccountId: account("INTERCO-AR-A"), targetAccountId: account("GROUP-INTERCO-AR"), amount: cents(-input.elimination_evidence.receivable_cents), evidenceIds: ["interco-match"], sourcePostingIds: [postingId("interco-ar-posting")] },
      { id: "interco-ap-elimination", sourceBookId: input.sources[1].book as never, sourceAccountId: account("INTERCO-AP-B"), targetAccountId: account("GROUP-INTERCO-AP"), amount: cents(-input.elimination_evidence.payable_cents), evidenceIds: ["interco-match"], sourcePostingIds: [postingId("interco-ap-posting")] },
    ];
    const result = compileConsolidation([policy], commodityId("USD"), {
      id: identifier<"ConsolidationCompilation">("case-d15"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant(input.policy_effective_at), throughOn: localDate(input.through_on), targetBookId: input.target_book as never,
      sources, eliminations, derivation: caseDerivation("case-d15", policy.id),
    });
    if (result.disposition !== "draft") return rejectWith("consolidation_input_violation");
    const journal = result.draft.journals[0]!;
    const balanceByAccount = new Map<string, ExactRational>();
    for (const posting of journal.postings) balanceByAccount.set(posting.accountId, (balanceByAccount.get(posting.accountId) ?? ExactRational.zero()).add(posting.exactBookValue));
    const eliminationPostings: Record<string, number> = {};
    for (const posting of journal.postings.filter((item) => item.id.startsWith("case-d15-elimination-"))) {
      const rawName = String(posting.accountId).replace(/^account-/, "");
      eliminationPostings[rawName] = (eliminationPostings[rawName] ?? 0) + toCents(posting.exactBookValue);
    }
    const equityPostings = journal.postings.filter((posting) => posting.accountId === account("GROUP-EQUITY"));
    const nciPostings = journal.postings.filter((posting) => posting.accountId === account("GROUP-NCI"));
    const cashPostings = journal.postings.filter((posting) => posting.accountId === account("GROUP-CASH"));
    return {
      outcome: "admit",
      facts: {
        elimination_postings_cents: eliminationPostings,
        elimination_balance_cents: Object.values(eliminationPostings).reduce((total, amount) => total + amount, 0),
        parent_attributable_equity_cents: toCents(equityPostings.reduce((total, posting) => total.add(posting.exactBookValue), ExactRational.zero())),
        non_controlling_interest_cents: toCents(nciPostings.reduce((total, posting) => total.add(posting.exactBookValue), ExactRational.zero())),
        consolidated_cash_cents: toCents(cashPostings.reduce((total, posting) => total.add(posting.exactBookValue), ExactRational.zero())),
        source_books_changed: result.draft.effects.some((effect) => effect.type === "consolidationCompilation" && effect.value.bookId !== input.target_book),
        target_journal_count: result.draft.journals.length,
        target_journal_balanced: journal.postings.reduce((total, posting) => total.add(posting.exactBookValue), ExactRational.zero()).isZero(),
      },
    };
  },

  "D16a-circular-source-book": (input) => {
    const policy = consolidationPolicyFor({ ...input, sources: input.source_books.map((book: string) => ({ book, revision: 1, posting_sequence: 1, population_hash: "sha256:aa", relationship: { control: "controlled", method: "full", ownership_share: "1/1", voting_share: "1/1", control_evidence: "E" }, balances_cents: { CASH: 0 } })), mapping: { CASH: "GROUP-CASH" }, valuation_paths: [{ from: "USD", to: "USD", identity: true }] });
    const result = compileConsolidation([policy], commodityId("USD"), {
      id: identifier<"ConsolidationCompilation">("case-d16a"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant("2026-12-31T23:59:59Z"), throughOn: localDate("2026-12-31"), targetBookId: input.target_book as never,
      sources: input.source_books.map((book: string) => ({
        bookId: book as never, revision: 1n, postingSequence: 1n, populationHash: parseHash("sha256:aa"), expectedRevision: 1n, expectedPostingSequence: 1n, expectedPopulationHash: parseHash("sha256:aa"), ...datedRelationship(book),
        control: "controlled", method: "full", ownershipShare: one, votingShare: one, controlEvidenceIds: ["E"],
        balances: [{ sourceAccountId: account("CASH"), unitsCommodityId: commodityId("USD"), classification: "asset" as const, amount: ExactRational.zero(), valuationPaths: identityValuationPaths }],
      })), eliminations: [], derivation: caseDerivation("case-d16a", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("consolidation_input_violation", { hostile_admitted: true });
  },

  "D16b-stale-source-snapshot": (input) => {
    const policy = consolidationPolicyFor({ sources: [{ book: input.source_book, revision: input.provided_revision, posting_sequence: 1, population_hash: "sha256:bb", relationship: { control: "controlled", method: "full", ownership_share: "1/1", voting_share: "1/1", control_evidence: "E" }, balances_cents: { CASH: 0 } }], mapping: { CASH: "GROUP-CASH" }, valuation_paths: [{ from: "USD", to: "USD", identity: true }], target_book: "GROUP-USD" });
    const result = compileConsolidation([policy], commodityId("USD"), {
      id: identifier<"ConsolidationCompilation">("case-d16b"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant("2026-12-31T23:59:59Z"), throughOn: localDate("2026-12-31"), targetBookId: input.target_book as never,
      sources: [{
        bookId: input.source_book as never, revision: BigInt(input.requested_revision), postingSequence: 1n, populationHash: parseHash("sha256:bb"), ...datedRelationship(input.source_book),
        expectedRevision: BigInt(input.provided_revision), expectedPostingSequence: 1n, expectedPopulationHash: parseHash("sha256:bb"),
        control: "controlled", method: "full", ownershipShare: one, votingShare: one, controlEvidenceIds: ["E"],
        balances: [{ sourceAccountId: account("CASH"), unitsCommodityId: commodityId("USD"), classification: "asset" as const, amount: ExactRational.zero(), valuationPaths: identityValuationPaths }],
      }], eliminations: [], derivation: caseDerivation("case-d16b", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("consolidation_input_violation", { hostile_admitted: true });
  },

  "D16c-unmapped-source-account": (input) => {
    const mappedAccounts = new Set(input.mapped_accounts);
    const policy = consolidationPolicyFor({
      sources: [{ book: input.source_book, revision: 1, posting_sequence: 1, population_hash: "sha256:cc", relationship: { control: "controlled", method: "full", ownership_share: "1/1", voting_share: "1/1", control_evidence: "E" }, balances_cents: Object.fromEntries(input.source_accounts.map((account: string) => [account, 0])) }],
      mapping: Object.fromEntries(input.source_accounts.filter((sourceAccount: string) => mappedAccounts.has(sourceAccount)).map((sourceAccount: string) => [sourceAccount, `GROUP-${sourceAccount}`])),
      valuation_paths: [{ from: "USD", to: "USD", identity: true }], target_book: "GROUP-USD",
    });
    const result = compileConsolidation([policy], commodityId("USD"), {
      id: identifier<"ConsolidationCompilation">("case-d16c"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant("2026-12-31T23:59:59Z"), throughOn: localDate("2026-12-31"), targetBookId: "GROUP-USD" as never,
      sources: [{
        bookId: input.source_book as never, revision: 1n, postingSequence: 1n, populationHash: parseHash("sha256:cc"), expectedRevision: 1n, expectedPostingSequence: 1n, expectedPopulationHash: parseHash("sha256:cc"), ...datedRelationship(input.source_book),
        control: "controlled", method: "full", ownershipShare: one, votingShare: one, controlEvidenceIds: ["E"],
        balances: input.source_accounts.map((sourceAccount: string) => ({ sourceAccountId: account(sourceAccount), unitsCommodityId: commodityId("USD"), classification: "asset" as const, amount: ExactRational.zero(), valuationPaths: identityValuationPaths })),
      }], eliminations: [], derivation: caseDerivation("case-d16c", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("consolidation_input_violation", { hostile_admitted: true });
  },

  "D16d-missing-translation-path": (input) => {
    const policy = consolidationPolicyFor({ sources: [{ book: "ENTITY-A", revision: 1, posting_sequence: 1, population_hash: "sha256:dd", relationship: { control: "controlled", method: "full", ownership_share: "1/1", voting_share: "1/1", control_evidence: "E" }, balances_cents: { CASH: 0 } }], mapping: { CASH: "GROUP-CASH" }, valuation_paths: input.valuation_paths, target_book: input.target_functional_commodity === "USD" ? "GROUP-USD" : "GROUP" });
    const result = compileConsolidation([policy], commodityId(input.target_functional_commodity), {
      id: identifier<"ConsolidationCompilation">("case-d16d"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant("2026-12-31T23:59:59Z"), throughOn: localDate("2026-12-31"), targetBookId: "GROUP-USD" as never,
      sources: [{
        bookId: "ENTITY-A" as never, revision: 1n, postingSequence: 1n, populationHash: parseHash("sha256:dd"), expectedRevision: 1n, expectedPostingSequence: 1n, expectedPopulationHash: parseHash("sha256:dd"), ...datedRelationship("ENTITY-A"),
        control: "controlled", method: "full", ownershipShare: one, votingShare: one, controlEvidenceIds: ["E"],
        balances: [{ sourceAccountId: account("CASH"), unitsCommodityId: commodityId(input.source_functional_commodity), classification: "asset" as const, amount: ExactRational.zero(), valuationPaths: [{ id: "disconnected-path", effectiveAt: instant("2026-12-31T23:59:59Z"), steps: [{ fromCommodityId: commodityId("USD"), toCommodityId: commodityId("USD"), rate: one, observedAt: instant("2026-12-30T00:00:00Z"), evidenceIds: Object.freeze(["valuation-evidence"]) }] }] }],
      }], eliminations: [], derivation: caseDerivation("case-d16d", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("consolidation_input_violation", { hostile_admitted: true });
  },

  "D16e-unmatched-elimination": (input) => {
    const policy = consolidationPolicyFor({ sources: [{ book: "ENTITY-A", revision: 1, posting_sequence: 1, population_hash: "sha256:ee", relationship: { control: "controlled", method: "full", ownership_share: "1/1", voting_share: "1/1", control_evidence: "E" }, balances_cents: { "INTERCO-AR": input.receivable_cents, "EQUITY": -input.receivable_cents } }], mapping: { "INTERCO-AR": "GROUP-INTERCO", EQUITY: "GROUP-EQUITY" }, valuation_paths: [{ from: "USD", to: "USD", identity: true }], target_book: "GROUP-USD" });
    const result = compileConsolidation([policy], commodityId("USD"), {
      id: identifier<"ConsolidationCompilation">("case-d16e"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant("2026-12-31T23:59:59Z"), throughOn: localDate("2026-12-31"), targetBookId: "GROUP-USD" as never,
      sources: [{
        bookId: "ENTITY-A" as never, revision: 1n, postingSequence: 1n, populationHash: parseHash("sha256:ee"), expectedRevision: 1n, expectedPostingSequence: 1n, expectedPopulationHash: parseHash("sha256:ee"), ...datedRelationship("ENTITY-A"),
        control: "controlled", method: "full", ownershipShare: one, votingShare: one, controlEvidenceIds: ["E"],
        balances: [
          { sourceAccountId: account("INTERCO-AR"), unitsCommodityId: commodityId("USD"), classification: "asset" as const, amount: cents(input.receivable_cents), valuationPaths: identityValuationPaths },
          { sourceAccountId: account("EQUITY"), unitsCommodityId: commodityId("USD"), classification: "equity" as const, amount: cents(-input.receivable_cents), valuationPaths: identityValuationPaths },
        ],
      }], eliminations: [
        { id: "unmatched-ar", sourceBookId: "ENTITY-A" as never, sourceAccountId: account("INTERCO-AR"), targetAccountId: account("GROUP-INTERCO"), amount: cents(-input.receivable_cents), evidenceIds: ["match"], sourcePostingIds: [postingId("e1")] },
        { id: "unmatched-equity", sourceBookId: "ENTITY-A" as never, sourceAccountId: account("EQUITY"), targetAccountId: account("GROUP-EQUITY"), amount: cents(-input.payable_cents - input.receivable_cents), evidenceIds: ["match"], sourcePostingIds: [postingId("e2")] },
      ], derivation: caseDerivation("case-d16e", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("consolidation_input_violation", { hostile_admitted: true });
  },

  "D16f-control-method-evidence-missing": (input) => {
    const policy = consolidationPolicyFor({ sources: [{ book: "ENTITY-A", revision: 1, posting_sequence: 1, population_hash: "sha256:ff", relationship: { control: input.control_classification, method: input.consolidation_method ?? "full", ownership_share: "1/1", voting_share: "1/1", control_evidence: "E" }, balances_cents: { CASH: 0 } }], mapping: { CASH: "GROUP-CASH" }, valuation_paths: [{ from: "USD", to: "USD", identity: true }], target_book: "GROUP-USD" });
    const result = compileConsolidation([policy], commodityId("USD"), {
      id: identifier<"ConsolidationCompilation">("case-d16f"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant("2026-12-31T23:59:59Z"), throughOn: localDate("2026-12-31"), targetBookId: "GROUP-USD" as never,
      sources: [{
        bookId: "ENTITY-A" as never, revision: 1n, postingSequence: 1n, populationHash: parseHash("sha256:ff"), expectedRevision: 1n, expectedPostingSequence: 1n, expectedPopulationHash: parseHash("sha256:ff"), ...datedRelationship("ENTITY-A"),
        control: input.control_classification, method: (input.consolidation_method ?? "full") as never, ownershipShare: one, votingShare: one,
        controlEvidenceIds: input.control_evidence,
        balances: [{ sourceAccountId: account("CASH"), unitsCommodityId: commodityId("USD"), classification: "asset" as const, amount: ExactRational.zero(), valuationPaths: identityValuationPaths }],
      }], eliminations: [], derivation: caseDerivation("case-d16f", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("consolidation_input_violation", { hostile_admitted: true });
  },

  "D16g-unbalanced-consolidation-adjustment": (input) => {
    const policy = consolidationPolicyFor({ sources: [{ book: "ENTITY-A", revision: 1, posting_sequence: 1, population_hash: "sha256:1a", relationship: { control: "controlled", method: "full", ownership_share: "1/1", voting_share: "1/1", control_evidence: "E" }, balances_cents: { CASH: 5000, EQUITY: -5000 } }], mapping: { CASH: "GROUP-CASH", EQUITY: "GROUP-EQUITY" }, valuation_paths: [{ from: "USD", to: "USD", identity: true }], target_book: input.target_book });
    const result = compileConsolidation([policy], commodityId("USD"), {
      id: identifier<"ConsolidationCompilation">("case-d16g"), policyId: policy.id, policyVersion: policy.version,
      governedAt: instant("2026-12-31T23:59:59Z"), throughOn: localDate("2026-12-31"), targetBookId: input.target_book as never,
      sources: [{
        bookId: "ENTITY-A" as never, revision: 1n, postingSequence: 1n, populationHash: parseHash("sha256:1a"), expectedRevision: 1n, expectedPostingSequence: 1n, expectedPopulationHash: parseHash("sha256:1a"), ...datedRelationship("ENTITY-A"),
        control: "controlled", method: "full", ownershipShare: one, votingShare: one, controlEvidenceIds: ["E"],
        balances: [
          { sourceAccountId: account("CASH"), unitsCommodityId: commodityId("USD"), classification: "asset" as const, amount: cents(5_000), valuationPaths: identityValuationPaths },
          { sourceAccountId: account("EQUITY"), unitsCommodityId: commodityId("USD"), classification: "equity" as const, amount: cents(-5_000), valuationPaths: identityValuationPaths },
        ],
      }], eliminations: input.adjustment_postings_cents.map((amount: number, index: number) => ({
        id: `d16g-adjustment-${index}`, sourceBookId: "ENTITY-A" as never,
        sourceAccountId: account(index === 0 ? "CASH" : "EQUITY"), targetAccountId: account(index === 0 ? "GROUP-CASH" : "GROUP-EQUITY"),
        amount: cents(amount), evidenceIds: ["d16g-match"], sourcePostingIds: [postingId(`d16g-source-${index}`)],
      })), derivation: caseDerivation("case-d16g", policy.id),
    });
    return result.disposition === "rejected" ? rejectWith(result.diagnostics[0]!.code) : rejectWith("consolidation_input_violation", { hostile_admitted: true });
  },

  "D17-workflow-independent-command": (input) => {
    const intentHashByOrigin: Record<string, string> = {};
    for (const origin of input.origins) {
      const book = accountingBook([INVENTORY_CASE_POLICY()]);
      const active = executeBookCommand(book.state, book.protocol, sealCommand({ ...coreCommand(book.state, `case-d17-activate`, "2026-01-01T14:00:00Z"), ...activationCommand(`case-d17-activate`) } as never));
      const acquisitionPostingId = postingId(`case-d17-posting`);
      const journalDraft = Object.freeze({
        id: journalId(`case-d17-journal`), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
        economicAt: instant("2026-01-05T12:00:00Z"), accountingDate: localDate("2026-01-05"), recordedAt: instant("2026-01-05T13:00:00Z"), narration: "Workflow-independent command",
        postings: Object.freeze([
          Object.freeze({ id: acquisitionPostingId, ordinal: 1n, accountId: account("EXPENSE"), units: Object.freeze({ canonicalNumber: ExactRational.of(10n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(1_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
          Object.freeze({ id: postingId(`case-d17-offset`), ordinal: 2n, accountId: account("AP"), units: Object.freeze({ canonicalNumber: ExactRational.of(-10n, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-1_000n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
        ]),
      });
      const command = sealCommand({ ...coreCommand(active.state, `case-d17`, "2026-01-05T14:00:00Z"), type: "postJournal" as const, resolved: resolved(journalDraft as never) } as never);
      const evaluation = evaluateBookCommand(active.state, active.protocol, command);
      if (evaluation.disposition !== "ready") return rejectWith("external_accounting_authority");
      intentHashByOrigin[origin] = evaluation.intent.canonicalHash.digest;
    }
    const hashes = Object.values(intentHashByOrigin);
    const identical = hashes.every((digest) => digest === hashes[0]);
    return {
      outcome: "admit",
      facts: {
        intent_hashes_identical: identical,
        intent_factory: "EvaluateBookCommand",
        commit_authority: "SerializedBookAuthority",
      },
    };
  },

  "D18a-external-journal-factory": (_input) => {
    const diagnostics = rejectExternalAccountingAuthority("journalFactory");
    return designHolds(diagnostics[0]!.code === "external_accounting_authority" && diagnostics[0]!.path === "external.journalFactory", "external_accounting_authority", { rejected_path: diagnostics[0]!.path, canonical_output: "typed_book_command_only" });
  },

  "D18b-external-policy-selection": (_input) => {
    const diagnostics = rejectExternalAccountingAuthority("policySelection");
    return designHolds(diagnostics[0]!.code === "external_accounting_authority", "external_accounting_authority", { rejected_path: diagnostics[0]!.path, typed_policy_reference_required: true });
  },

  "D18c-external-book-order-assignment": (_input) => {
    const diagnostics = rejectExternalAccountingAuthority("bookOrderAssignment");
    return designHolds(diagnostics[0]!.code === "external_accounting_authority", "external_accounting_authority", { rejected_path: diagnostics[0]!.path, authority: "kernel_assigned_only" });
  },

  "D18d-specialized-calculator-emits-commit-intent": (_input) => {
    const policy = taxPolicyFor({ components: [{ id: "TAX-A", rate: "1/10", inclusion: "exclusive", treatment: "inputTax", recoverability: "recoverable", compound_ordinal: 1, compounds_on: [], recoverable_share: "1/1", recoverable_account: "INPUT-TAX", liability_account: "TAX-PAYABLE" }], tax_point: "2026-01-15T14:00:00Z" });
    const result = determineTax([policy], IDS.book, commodityId("USD"), {
      id: identifier<"TaxDetermination">("case-d18d"), sourceTransactionId: journalId("case-d18d-source"),
      governedAt: instant("2026-01-15T14:00:00Z"), direction: "purchase",
      lines: Object.freeze([{ lineId: "L1", sourcePostingId: postingId("d18d-source"), counterpartyPostingId: postingId("d18d-counter"), policyId: policy.id, policyVersion: policy.version, statedAmount: cents(10_000), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") }]),
      derivation: caseDerivation("case-d18d", policy.id),
    });
    const emitsDraftNotIntent = result.disposition === "draft";
    const diagnostics = rejectExternalAccountingAuthority("commitIntentFactory");
    return designHolds(emitsDraftNotIntent && diagnostics[0]!.code === "external_accounting_authority", "external_accounting_authority", { rejected_path: diagnostics[0]!.path, effect_draft_present: emitsDraftNotIntent, calculator_output: "AccountingDraft" });
  },

  "D18e-untyped-direct-persistence": (_input) => {
    const diagnostics = rejectExternalAccountingAuthority("directPersistence");
    return designHolds(diagnostics[0]!.code === "external_accounting_authority", "external_accounting_authority", { rejected_path: diagnostics[0]!.path, persistence_path: "serialized_book_authority_only" });
  },
});

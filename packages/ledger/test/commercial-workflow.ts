import {
  ExactDecimal,
  ExactRational,
  accountId,
  bookId,
  canonicalPostingReferenceId,
  commandId,
  consolidationCompilationId,
  createBookState,
  createCanonicalPostingReference,
  derivationId,
  effectKey,
  evidenceId,
  fiscalPeriodId,
  hashAccountingPolicyArtifact,
  hashCanonical,
  instant,
  inventoryRecostingId,
  inventoryValueAdjustmentId,
  localDate,
  lotHoldingId,
  lotId,
  openItemId,
  policyId,
  provisionalInventoryLayerId,
  resolveJournal,
  sealCommand,
  semanticVersion,
  settlementAllocationId,
  settlementId,
  type AccountId,
  type AccountingFeature,
  type AccountingPolicyArtifactCore,
  type BookCommand,
  type ConsolidationPolicy,
  type InventoryCostPolicy,
  type InventoryValueAdjustmentPolicy,
  type ResolvedTransaction,
} from "@rastrata/kernel";
import { activation, BOOK, CASH, posting } from "./fixtures.ts";
import { lotIdentityWorkflow, workflowValue } from "./accounting-workflows.ts";

/** A standalone group reporting book; no inventory or subsidiary ledger state is
 * smuggled into its current-state adapter. The request carries pinned observations. */
export function consolidationWorkflow(ownershipShare = ExactRational.of(1n, 1n)) {
  const scenario = commercialWorkflow();
  const configuration = scenario.initial.state.activeConfigurationSnapshot;
  const compilation = scenario.commands.find((command) => command.type === "compileConsolidation");
  if (compilation === undefined) throw new Error("Missing compilation fixture");
  const initial = {
    ...scenario.initial,
    state: createBookState(
      scenario.initial.state.identity,
      configuration.periods,
      configuration.admissionSnapshot,
      configuration.policies,
      configuration.quantizationPolicies,
      configuration.accountingPolicySnapshot.policies.filter(
        (policy) => policy.kind === "consolidation",
      ),
      configuration.effectiveAt,
    ),
  };
  const command = sealCommand({
    ...compilation,
    expectedBookRevision: 1n,
    request: {
      ...compilation.request,
      sources: compilation.request.sources.map((source) => ({
        ...source,
        ownershipShare,
        votingShare: ownershipShare,
        ...(ownershipShare.compare(ExactRational.of(1n, 1n)) < 0
          ? { nonControllingInterestMethod: "proportionateNetAssets" as const }
          : {}),
      })),
    },
  });
  return { initial, command, commands: [activation(), command], accounts: scenario.accounts };
}

/** Public-kernel command inputs only. No private kernel fixture imports, synthetic
 * effect injection, or expectation derived from the indexed projection mapper. */
export function commercialWorkflow() {
  const lots = lotIdentityWorkflow();
  const base = lots.initial.state;
  const R = (value: bigint) => ExactRational.of(value, 1n);
  const version = semanticVersion("1.0.0");
  const governedAt = instant("2026-01-15T14:00:00Z");
  const from = instant("2020-01-01T00:00:00Z");
  const quantization = workflowValue(base.quantizationPolicies[0]);
  const A = {
    ar: accountId("commercial-ar"),
    bank: accountId("commercial-bank"),
    cost: accountId("commercial-cost"),
    adjustment: accountId("commercial-adjustment"),
    equity: accountId("commercial-equity"),
    nci: accountId("commercial-nci"),
    translation: accountId("commercial-translation"),
  };
  const evidence = {
    id: evidenceId("commercial-evidence"),
    sourceSystem: "ledger-test",
    sourceRecordId: "commercial-workflow",
    observedAt: instant("2026-01-01T00:00:00Z"),
    contentHash: hashCanonical("commercial-source-evidence"),
  };
  const derivation = (id: ReturnType<typeof policyId>) => ({
    id: derivationId(`${id}-derivation`),
    policyId: id,
    policyVersion: version,
    algorithmVersion: version,
    inputHash: hashCanonical("commercial-input"),
    actorId: activation().actorId,
    state: "approved" as const,
    recordedAt: evidence.observedAt,
    evidence: [evidence],
  });
  const corePolicy = (id: string, feature: AccountingFeature, method: string) => ({
    id: policyId(id),
    bookId: BOOK,
    version,
    validFrom: from,
    algorithmVersion: version,
    quantizationPolicy: quantization,
    capability: {
      feature,
      status: "supported" as const,
      implementationVersion: version,
      verificationEvidenceIds: [evidence.id],
      admittedCombinations: [{ method }],
    },
  });
  const artifact = <
    T extends Omit<AccountingPolicyArtifactCore, "contentHash"> & Record<string, unknown>,
  >(
    kind: string,
    value: T,
  ) => ({ ...value, contentHash: hashAccountingPolicyArtifact(kind, value) });
  const inventory: InventoryCostPolicy = {
    ...corePolicy("commercial-fifo", "inventoryCost", "fifo"),
    kind: "inventoryCost",
    method: "fifo",
    shortageTreatment: "provisionalNegative",
    provisionalBasisMethod: "explicitRate",
    provisionalRate: R(7n),
    pools: [artifact("InventoryPool", { id: policyId("commercial-pool"), accountId: CASH })],
  };
  const valuePolicy: InventoryValueAdjustmentPolicy = {
    ...corePolicy("commercial-inventory-value", "inventoryValueAdjustment", "valueAdjustment"),
    kind: "inventoryValueAdjustment",
    inventoryCostPolicyId: inventory.id,
    inventoryCostPolicyVersion: version,
    allowedKinds: ["directlyAttributableCost"],
    inventoryAccountId: CASH,
    recognizedCostAccountId: A.cost,
    adjustmentAccountId: A.adjustment,
  };
  const sourceBook = bookId("commercial-subsidiary");
  const valuation = (id: string) => ({
    id: policyId(id),
    version,
    validFrom: from,
    maximumHops: 1n,
    allowInverseObservation: false,
    preferDirectObservation: true,
  });
  const consolidation: ConsolidationPolicy = {
    ...corePolicy("commercial-consolidation", "consolidation", "full"),
    kind: "consolidation",
    supportedMethods: ["full"],
    valuationPolicy: valuation("commercial-global-valuation"),
    accountMappings: [CASH, A.equity].map((account, i) =>
      artifact("ConsolidationAccountMapping", {
        id: policyId(`commercial-mapping-${i}`),
        sourceBookId: sourceBook,
        sourceAccountId: account,
        targetAccountId: account,
        validFrom: from,
      }),
    ),
    translationRules: [CASH, A.equity].map((account, i) =>
      artifact("ConsolidationTranslationRule", {
        id: policyId(`commercial-translation-${i}`),
        sourceBookId: sourceBook,
        sourceAccountId: account,
        targetAccountId: account,
        validFrom: from,
        valuationPolicy: valuation(`commercial-rule-valuation-${i}`),
      }),
    ),
    translationAdjustmentAccountId: A.translation,
    parentAttributableEquityAccountId: A.equity,
    nonControllingInterestAccountId: A.nci,
  };
  const accountTemplate = workflowValue(base.admissionSnapshot.accounts[0]);
  const initial = {
    ...lots.initial,
    state: createBookState(
      base.identity,
      base.periods,
      {
        ...base.admissionSnapshot,
        accounts: [
          ...base.admissionSnapshot.accounts,
          ...Object.values(A).map((id, index) => ({
            ...accountTemplate,
            id,
            code: `commercial-${index}`,
            name: id,
            role:
              id === A.cost
                ? ("expense" as const)
                : id === A.equity || id === A.nci
                  ? ("equity" as const)
                  : ("asset" as const),
            normalSide: id === A.equity || id === A.nci ? ("credit" as const) : ("debit" as const),
          })),
        ],
      },
      base.policies,
      base.quantizationPolicies,
      [inventory, valuePolicy, consolidation],
      from,
    ),
  };
  const commands: BookCommand[] = [activation()];
  const core = (id: string) => ({
    id: commandId(id),
    bookId: BOOK,
    actorId: activation().actorId,
    protocolVersion: version,
    expectedBookRevision: BigInt(commands.length),
    issuedAt: governedAt,
    completedAt: instant("2026-01-15T14:00:01Z"),
    committedAt: instant("2026-01-15T14:00:02Z"),
  });
  function transaction(
    id: string,
    first: AccountId,
    second: AccountId,
    amount: bigint,
    kind: "ordinary" | "reversing" = "ordinary",
  ) {
    const template = posting(id, BigInt(commands.length));
    if (template.type !== "postJournal") throw new Error("Expected journal template");
    const journal = {
      ...template.resolved.journal,
      kind,
      postings: template.resolved.journal.postings.map((p, i) => ({
        ...p,
        accountId: i === 0 ? first : second,
        units: { ...p.units, canonicalNumber: R(i === 0 ? amount : -amount) },
        bookValue: {
          ...p.bookValue,
          amount: ExactDecimal.of((i === 0 ? amount : -amount) * 100n, 2n),
        },
      })),
    };
    const resolved = resolveJournal(
      journal,
      base.policies,
      base.identity.ownerId,
      quantization,
      journal.postings.map((p) => p.bookValue.amount.toRational()),
    );
    if (Array.isArray(resolved)) throw new Error("Commercial journal must resolve");
    return { journal, resolved: resolved as ResolvedTransaction };
  }
  const reference = (id: string, journal: ReturnType<typeof transaction>["journal"]) =>
    createCanonicalPostingReference(
      canonicalPostingReferenceId(`${id}-reference`),
      BOOK,
      journal.id,
      workflowValue(journal.postings[0]),
      effectKey(`${id}:journal:0`),
    );

  // A genuine shortage precedes stock acquisition. Later external receipt evidence
  // settles the provisional basis without inventing a physical lot holding.
  const provisional = provisionalInventoryLayerId("commercial-provisional");
  commands.push(
    sealCommand({
      ...core("commercial-shortage"),
      type: "postInventoryTransaction",
      request: {
        policyId: inventory.id,
        policyVersion: version,
        governedAt,
        quantity: R(1n),
        layers: [],
      },
      inventoryAccountId: CASH,
      costAccountId: A.cost,
      inventoryCommodityId: base.identity.functionalCommodityId,
      provisionalLayerId: provisional,
      derivation: derivation(inventory.id),
    }),
  );
  commands.push(
    sealCommand({
      ...core("commercial-recost"),
      type: "recostProvisionalInventory",
      fiscalPeriodId: fiscalPeriodId("january"),
      request: {
        id: inventoryRecostingId("commercial-recosting"),
        layerId: provisional,
        resolvedAt: governedAt,
        sources: [{ receiptId: "commercial-receipt", quantity: R(1n), totalBasis: R(9n) }],
        derivation: derivation(inventory.id),
      },
      inventoryAccountId: CASH,
      adjustmentAccountId: A.adjustment,
    }),
  );
  const stockId = "commercial-stock";
  commands.push(lots.acquire(stockId, BigInt(commands.length), 10n));
  commands.push(
    sealCommand({
      ...core("commercial-value"),
      type: "adjustInventoryValue",
      fiscalPeriodId: fiscalPeriodId("january"),
      request: {
        id: inventoryValueAdjustmentId("commercial-value-adjustment"),
        kind: "directlyAttributableCost",
        effectiveOn: localDate("2026-01-15"),
        policyEffectiveAt: governedAt,
        policyId: valuePolicy.id,
        policyVersion: version,
        generatedEffectKey: effectKey("commercial-value:journal:0"),
        exactSourceAmount: R(5n),
        allocations: [
          {
            ordinal: 1n,
            lotId: lotId(stockId),
            holdingId: lotHoldingId(stockId),
            remainingBasisChange: R(5n),
            recognizedCostChange: R(0n),
            remainingValuationAllowanceChange: R(0n),
          },
        ],
        evidence: [evidence],
        derivation: derivation(valuePolicy.id),
      },
    }),
  );

  const recognition = transaction("commercial-invoice", A.ar, accountId("income"), 100n);
  const openId = openItemId("commercial-open-item");
  const scope = { externalPartyId: "commercial-customer", controlAccountId: A.ar };
  const bookingDerivation = derivation(workflowValue(base.policies[0]).id);
  commands.push(
    sealCommand({
      ...core("commercial-invoice"),
      type: "recognizeOpenItem",
      resolved: recognition.resolved,
      request: {
        value: {
          id: openId,
          bookId: BOOK,
          kind: "receivable",
          scope,
          recognitionSource: reference("commercial-invoice", recognition.journal),
          recognizedOn: recognition.journal.accountingDate,
          denominationCommodityId: base.identity.functionalCommodityId,
          denomination: R(100n),
          bookValue: R(100n),
          derivation: bookingDerivation,
        },
      },
    }),
  );
  const payment = transaction("commercial-payment", A.ar, A.bank, -100n);
  const paidId = settlementId("commercial-settlement");
  commands.push(
    sealCommand({
      ...core("commercial-payment"),
      type: "applySettlement",
      resolved: [payment.resolved],
      request: {
        settlement: {
          id: paidId,
          bookId: BOOK,
          kind: "cash",
          scope,
          settlementSource: reference("commercial-payment", payment.journal),
          settledAt: governedAt,
          denominationCommodityId: base.identity.functionalCommodityId,
          denomination: R(100n),
          bookValue: R(100n),
          derivation: bookingDerivation,
        },
        allocations: [
          {
            id: settlementAllocationId("commercial-payment-allocation"),
            openItemId: openId,
            settlementId: paidId,
            allocatedBookValue: R(100n),
            allocatedOpenQuantity: R(100n),
            allocatedSettlementQuantity: R(100n),
            derivation: bookingDerivation,
          },
        ],
      },
    }),
  );

  const mistaken = transaction("commercial-mistake", A.bank, accountId("income"), 12n);
  commands.push(
    sealCommand({
      ...core("commercial-mistake"),
      type: "postJournal",
      resolved: mistaken.resolved,
    }),
  );
  const reversal = transaction(
    "commercial-correction",
    A.bank,
    accountId("income"),
    -12n,
    "reversing",
  );
  commands.push(
    sealCommand({
      ...core("commercial-correction"),
      type: "correctJournal",
      correctionKind: "reversal",
      originalJournalId: mistaken.journal.id,
      resolved: { ...reversal.resolved, derivations: [bookingDerivation] },
    }),
  );
  const populationHash = hashCanonical("commercial-subsidiary-through-january-15");
  commands.push(
    sealCommand({
      ...core("commercial-consolidate"),
      type: "compileConsolidation",
      request: {
        id: consolidationCompilationId("commercial-compilation"),
        policyId: consolidation.id,
        policyVersion: version,
        governedAt,
        throughOn: localDate("2026-01-15"),
        targetBookId: BOOK,
        sources: [
          {
            bookId: sourceBook,
            revision: 1n,
            postingSequence: 1n,
            populationHash,
            expectedRevision: 1n,
            expectedPostingSequence: 1n,
            expectedPopulationHash: populationHash,
            relationshipId: "commercial-control",
            relationshipValidFrom: from,
            control: "controlled",
            method: "full",
            ownershipShare: R(1n),
            votingShare: R(1n),
            controlEvidenceIds: [evidence.id],
            balances: [
              {
                sourceAccountId: CASH,
                unitsCommodityId: base.identity.functionalCommodityId,
                classification: "asset",
                amount: R(50n),
                valuationPaths: [],
              },
              {
                sourceAccountId: A.equity,
                unitsCommodityId: base.identity.functionalCommodityId,
                classification: "equity",
                amount: R(-50n),
                valuationPaths: [],
              },
            ],
          },
        ],
        eliminations: [],
        derivation: derivation(consolidation.id),
      },
    }),
  );
  return { initial, commands, accounts: A, stockId, provisional, openId, paidId };
}

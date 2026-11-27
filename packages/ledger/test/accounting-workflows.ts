import {
  ExactRational,
  ExactDecimal,
  accountId,
  actorId,
  allocationRecognitionId,
  allocationScheduleId,
  allocationScheduleRevisionId,
  canonicalPostingReferenceId,
  commandId,
  createBookState,
  createCanonicalPostingReference,
  derivationId,
  effectKey,
  evidenceId,
  fiscalPeriodId,
  hashAccountingPolicyArtifact,
  hashCanonical,
  instant,
  journalId,
  localDate,
  policyId,
  postingId,
  resolveJournal,
  sealCommand,
  semanticVersion,
  taxDeterminationId,
  type AllocationPolicy,
  type BookCommand,
  type TaxPolicy,
  type ResolvedTransaction,
  type LotOperation,
  lotId,
  lotHoldingId,
  lotAllocationId,
  commodityId,
  remeasurementResultId,
  remeasurementReversalId,
  type CurrencyPolicy,
  type MonetaryClassificationPolicy,
  type InventoryCostPolicy,
  type BookState,
  calculateInventoryCost,
} from "@rastrata/kernel";
import { activation, BOOK, CASH, genesis, posting } from "./fixtures.ts";

export function workflowValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing required accounting workflow value");
  return value;
}

/** Two independent GBP monetary positions, measured under distinct policies.
 * Policy array order intentionally differs from result insertion order. */
export function admissionFxWorkflow(reversalRequired = true) {
  const base = genesis();
  const quantizationPolicy = workflowValue(base.state.quantizationPolicies[0]);
  const version = semanticVersion("1.0.0");
  const evidence = {
    id: evidenceId("admission-fx-evidence"),
    sourceSystem: "ledger-test",
    sourceRecordId: "fx-rate",
    observedAt: instant("2026-01-01T00:00:00Z"),
    contentHash: hashCanonical({ rate: "GBP/USD" }),
  };
  const core = {
    version,
    bookId: BOOK,
    validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: version,
    quantizationPolicy,
  };
  const gain = accountId("fx-gain"),
    loss = accountId("fx-loss");
  const currency = (id: string): CurrencyPolicy => ({
    ...core,
    id: policyId(id),
    kind: "currencyRemeasurement",
    reversalRequired,
    gainAccountId: gain,
    lossAccountId: loss,
    capability: {
      feature: "currencyRemeasurement",
      status: "supported",
      implementationVersion: version,
      admittedCombinations: [{ method: "closingRate" }],
      verificationEvidenceIds: [evidence.id],
    },
  });
  const firstPolicy = currency("fx-policy-first"),
    secondPolicy = currency("fx-policy-second");
  const rule = {
    id: policyId("fx-cash-classification"),
    accountId: CASH,
    classification: "monetary" as const,
  };
  const monetary: MonetaryClassificationPolicy = {
    ...core,
    id: policyId("fx-monetary"),
    kind: "monetaryClassification",
    rules: [
      { ...rule, contentHash: hashAccountingPolicyArtifact("MonetaryClassificationRule", rule) },
    ],
    capability: {
      feature: "monetaryClassification",
      status: "supported",
      implementationVersion: version,
      admittedCombinations: [{ method: "accountRule" }],
      verificationEvidenceIds: [evidence.id],
    },
  };
  const initial = {
    ...base,
    state: createBookState(
      base.state.identity,
      base.state.periods,
      {
        ...base.state.admissionSnapshot,
        accounts: [
          ...base.state.admissionSnapshot.accounts,
          {
            ...workflowValue(base.state.admissionSnapshot.accounts[1]),
            id: gain,
            code: "7000",
            name: "FX gain",
          },
          {
            ...workflowValue(base.state.admissionSnapshot.accounts[0]),
            id: loss,
            code: "7100",
            name: "FX loss",
            role: "expense" as const,
          },
        ],
      },
      base.state.policies,
      base.state.quantizationPolicies,
      [secondPolicy, firstPolicy, monetary],
      instant("2020-01-01T00:00:00Z"),
    ),
  };
  const derivation = {
    id: derivationId("admission-fx-derivation"),
    policyId: workflowValue(base.state.policies[0]).id,
    policyVersion: version,
    algorithmVersion: version,
    inputHash: hashCanonical({ workflow: "admission-fx" }),
    actorId: actorId("actor"),
    state: "approved" as const,
    recordedAt: evidence.observedAt,
    evidence: [evidence],
  };
  const position = (id: string, revision: bigint) => {
    const template = posting(id, revision);
    if (template.type !== "postJournal") throw new Error("Expected posting fixture");
    const journal = {
      ...template.resolved.journal,
      postings: template.resolved.journal.postings.map((p, i) => ({
        ...p,
        units: {
          canonicalNumber: ExactRational.of(i === 0 ? 50n : -50n, 1n),
          commodityId: commodityId("GBP"),
        },
      })),
    };
    const resolved = resolveJournal(
      journal,
      initial.state.policies,
      initial.state.identity.ownerId,
      quantizationPolicy,
      journal.postings.map((p) => p.bookValue.amount.toRational()),
    );
    if (Array.isArray(resolved)) throw new Error("FX source journal did not resolve");
    return sealCommand({ ...template, resolved: resolved as ResolvedTransaction });
  };
  const first = position("fx-source-first", 1n),
    second = position("fx-source-second", 2n);
  const measure = (
    sourceCommand: typeof first,
    policy: CurrencyPolicy,
    id: string,
    revision: bigint,
    hour: string,
  ) => {
    const at = `2026-01-16T${hour}:00`;
    const source = createCanonicalPostingReference(
      canonicalPostingReferenceId(`${id}-source`),
      BOOK,
      sourceCommand.resolved.journal.id,
      workflowValue(sourceCommand.resolved.journal.postings[0]),
      effectKey(`${sourceCommand.id}:journal:0`),
    );
    return sealCommand({
      id: commandId(id),
      type: "postCurrencyRemeasurement" as const,
      protocolVersion: version,
      actorId: actorId("actor"),
      bookId: BOOK,
      expectedBookRevision: revision,
      issuedAt: instant(`${at}Z`),
      completedAt: instant(`${at.replace(/00$/, "01")}Z`),
      committedAt: instant(`${at.replace(/00$/, "02")}Z`),
      request: {
        id: remeasurementResultId(id),
        policyId: policy.id,
        policyVersion: version,
        classificationPolicyId: monetary.id,
        classificationPolicyVersion: version,
        governedAt: instant(`${at}Z`),
        kind: "unrealized" as const,
        classification: "monetary" as const,
        source,
        generatedEffectKey: effectKey(`${id}:journal:0`),
        effectiveOn: localDate("2026-01-16"),
        denominationCommodityId: commodityId("GBP"),
        denomination: ExactRational.of(50n, 1n),
        carryingBookValue: ExactRational.of(100n, 1n),
        valuationPath: {
          fromCommodityId: commodityId("GBP"),
          toCommodityId: initial.state.identity.functionalCommodityId,
          effectiveAt: instant(`${at}Z`),
          observedAt: evidence.observedAt,
          rate: ExactRational.of(3n, 1n),
          evidenceIds: [evidence.id],
        },
        positionAccountId: CASH,
        derivation,
      },
    });
  };
  const firstMeasurement = measure(first, firstPolicy, "fx-first", 3n, "12:00"),
    secondMeasurement = measure(second, secondPolicy, "fx-second", 4n, "13:00");
  const reverse = (original: typeof firstMeasurement, revision: bigint) => {
    const id = `${original.id}-reversal`;
    return sealCommand({
      ...original,
      id: commandId(id),
      expectedBookRevision: revision,
      issuedAt: instant("2026-01-16T15:00:00Z"),
      completedAt: instant("2026-01-16T15:00:01Z"),
      committedAt: instant("2026-01-16T15:00:02Z"),
      request: {
        ...original.request,
        id: remeasurementResultId(`${id}-placeholder`),
        reversalOf: original.request.id,
        reversalId: remeasurementReversalId(id),
        generatedEffectKey: effectKey(`${id}:journal:0`),
      },
    });
  };
  return {
    initial,
    commands: [activation(), first, second, firstMeasurement, secondMeasurement],
    firstMeasurement,
    secondMeasurement,
    reverse,
  };
}

/** Next-day recovery of two independent required FX reversals. */
export function currencyRecoveryWorkflow() {
  const scenario = admissionFxWorkflow();
  const nextDay = <T extends BookCommand>(command: T) =>
    sealCommand({
      ...command,
      issuedAt: instant("2026-01-17T18:00:00Z"),
      completedAt: instant("2026-01-17T18:00:01Z"),
      committedAt: instant("2026-01-17T18:00:02Z"),
    });
  const reverse = (original: typeof scenario.firstMeasurement, revision: bigint) => {
    const command = scenario.reverse(original, revision);
    return nextDay(
      sealCommand({
        ...command,
        request: {
          ...command.request,
          governedAt: instant("2026-01-17T18:00:00Z"),
          effectiveOn: localDate("2026-01-17"),
          valuationPath: {
            ...command.request.valuationPath,
            effectiveAt: instant("2026-01-17T18:00:00Z"),
          },
        },
      }),
    );
  };
  return {
    initial: scenario.initial,
    commands: [
      ...scenario.commands,
      nextDay(posting("fx-overdue-both", 5n)),
      reverse(scenario.firstMeasurement, 5n),
      nextDay(posting("fx-overdue-one", 6n)),
      reverse(scenario.secondMeasurement, 6n),
      nextDay(posting("fx-after-reversals", 7n)),
    ],
  };
}

/** A real lot lifecycle: append identities, update/coalesce a destination, then
 * fully drain the original holding without removing its canonical row. */
export function inventoryReadWorkflow() {
  const lots = lotIdentityWorkflow();
  const base = lots.initial.state;
  const policy: InventoryCostPolicy = {
    id: policyId("inventory-read-fifo"),
    kind: "inventoryCost",
    version: semanticVersion("1.0.0"),
    bookId: BOOK,
    validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: semanticVersion("1.0.0"),
    quantizationPolicy: workflowValue(base.quantizationPolicies[0]),
    capability: {
      feature: "inventoryCost",
      status: "supported",
      implementationVersion: semanticVersion("1.0.0"),
      verificationEvidenceIds: [evidenceId("inventory-read-policy")],
      admittedCombinations: [{ method: "fifo" }],
    },
    method: "fifo",
    shortageTreatment: "reject",
    pools: [accountId("second-location"), CASH, accountId("income")].map((accountId, i) => {
      const value = { id: policyId(`inventory-pool-${i}`), accountId };
      return { ...value, contentHash: hashAccountingPolicyArtifact("InventoryPool", value) };
    }),
  };
  const initial = {
    ...lots.initial,
    state: createBookState(
      base.identity,
      base.periods,
      base.admissionSnapshot,
      base.policies,
      base.quantizationPolicies,
      [policy],
      instant("2020-01-01T00:00:00Z"),
    ),
  };
  const command = (state: BookState, id = "inventory-read-issue") => {
    const layers = state.lotHoldings
      .filter(
        (holding) =>
          policy.pools.some((p) => p.accountId === holding.accountId) &&
          holding.commodityId === state.identity.functionalCommodityId &&
          !holding.remainingQuantity.isZero(),
      )
      .map((holding) => ({
        id: holding.id,
        accountId: holding.accountId,
        acquiredAt: workflowValue(state.lots.find((l) => l.id === holding.lotId)).acquiredAt,
        quantity: holding.remainingQuantity,
        totalBasis: holding.remainingTotalBasis,
      }));
    const request = {
      policyId: policy.id,
      policyVersion: policy.version,
      governedAt: instant("2026-01-16T12:00:00Z"),
      quantity: ExactRational.of(1n, 1n),
      layers,
    };
    const cost = calculateInventoryCost(state.accountingPolicySnapshot.policies, BOOK, request);
    if (cost.disposition !== "costed") throw new Error("Inventory read fixture must cost");
    const first = workflowValue(cost.allocations[0]);
    const inventoryAccountId = workflowValue(layers.find((l) => l.id === first.layerId)).accountId;
    const original = workflowValue(lots.commands.at(-1));
    if (original.type !== "postJournal") throw new Error("Disposal fixture required");
    const operation = workflowValue(original.lotOperations?.[0]);
    if (operation.type !== "dispose") throw new Error("Disposal fixture required");
    const derivation = {
      ...operation.derivation,
      policyId: policy.id,
      policyVersion: policy.version,
    };
    return sealCommand({
      id: commandId(id),
      type: "postInventoryTransaction" as const,
      bookId: BOOK,
      actorId: activation().actorId,
      protocolVersion: activation().protocolVersion,
      expectedBookRevision: state.bookRevision,
      issuedAt: instant("2026-01-16T12:00:00Z"),
      completedAt: instant("2026-01-16T12:00:01Z"),
      committedAt: instant("2026-01-16T12:00:02Z"),
      request,
      inventoryAccountId,
      inventoryCommodityId: state.identity.functionalCommodityId,
      costAccountId: accountId("income"),
      derivation,
      lotOperations: [
        {
          type: "dispose" as const,
          holdingIds: cost.allocations.map((a) => lotHoldingId(a.layerId)),
          requestedQuantity: request.quantity,
          selection: { method: "fifo" as const },
          derivation,
          identities: cost.allocations.map((a) => ({
            holdingId: lotHoldingId(a.layerId),
            allocationId: lotAllocationId(`${id}-${a.layerId}`),
          })),
          journalPostingId: postingId(`${id}-inventory`),
        },
      ],
    });
  };
  return { ...lots, initial, policy, command };
}

export function lotIdentityWorkflow() {
  const base = genesis();
  const second = accountId("second-location");
  const initial = {
    ...base,
    state: createBookState(
      base.state.identity,
      base.state.periods,
      {
        ...base.state.admissionSnapshot,
        accounts: [
          ...base.state.admissionSnapshot.accounts,
          {
            ...workflowValue(base.state.admissionSnapshot.accounts[0]),
            id: second,
            code: "1100",
            name: "Second location",
          },
        ],
      },
      base.state.policies,
      base.state.quantizationPolicies,
      [],
      instant("2020-01-01T00:00:00Z"),
    ),
  };
  const functional = base.state.identity.functionalCommodityId;
  const R = (n: bigint) => ExactRational.of(n, 1n);
  const derivation = {
    id: derivationId("lot-lifecycle-derivation"),
    policyId: workflowValue(base.state.policies[0]).id,
    policyVersion: semanticVersion("1.0.0"),
    algorithmVersion: semanticVersion("1.0.0"),
    inputHash: hashCanonical({ scenario: "lot-lifecycle" }),
    actorId: actorId("actor"),
    state: "approved" as const,
    recordedAt: instant("2026-01-15T12:00:00Z"),
    evidence: [
      {
        id: evidenceId("lot-lifecycle-evidence"),
        sourceSystem: "ledger-test",
        sourceRecordId: "lot-lifecycle",
        observedAt: instant("2026-01-15T12:00:00Z"),
        contentHash: hashCanonical({ source: "lot-lifecycle" }),
      },
    ],
  };
  const make = (
    id: string,
    revision: bigint,
    quantity: bigint,
    destination: typeof CASH,
    operation: (
      first: ReturnType<typeof postingId>,
      last: ReturnType<typeof postingId>,
    ) => LotOperation,
  ): BookCommand => {
    const template = posting(id, revision);
    if (template.type !== "postJournal") throw new Error("Expected lot journal template");
    const journal = {
      ...template.resolved.journal,
      postings: template.resolved.journal.postings.map((p, i) => {
        const value = i === 0 ? quantity : -quantity;
        return {
          ...p,
          accountId: i === 0 ? CASH : destination,
          units: { ...p.units, canonicalNumber: R(value) },
          bookValue: { ...p.bookValue, amount: ExactDecimal.of(value * 100n, 2n) },
          ...(i === 0 ? { costBasis: { totalBasis: R(value), basisCommodityId: functional } } : {}),
        };
      }),
    };
    const resolved = resolveJournal(
      journal,
      base.state.policies,
      base.state.identity.ownerId,
      workflowValue(base.state.quantizationPolicies[0]),
      journal.postings.map((p) => p.bookValue.amount.toRational()),
    );
    if (Array.isArray(resolved)) throw new Error("Lot journal must resolve");
    return sealCommand({
      ...template,
      resolved: resolved as ResolvedTransaction,
      lotOperations: [
        operation(workflowValue(journal.postings[0]).id, workflowValue(journal.postings[1]).id),
      ],
    });
  };
  const acquire = (id: string, revision: bigint, quantity: bigint) =>
    make(id, revision, quantity, accountId("income"), (first) => ({
      type: "acquire",
      journalPostingId: first,
      lot: {
        id: lotId(id),
        bookId: BOOK,
        commodityId: functional,
        basisCommodityId: functional,
        acquiredAt: instant("2026-01-15T12:00:00Z"),
        acquisitionQuantity: R(quantity),
        acquisitionTotalBasis: R(quantity),
        evidenceIds: ["lot-evidence"],
      },
      holding: {
        id: lotHoldingId(id),
        bookId: BOOK,
        lotId: lotId(id),
        accountId: CASH,
        commodityId: functional,
        basisCommodityId: functional,
        remainingQuantity: R(quantity),
        remainingTotalBasis: R(quantity),
        remainingValuationAllowance: R(0n),
        remainingCarryingAmount: R(quantity),
      },
    }));
  const source = lotHoldingId("lot-first"),
    destination = lotHoldingId("lot-destination");
  const transfer = (id: string, revision: bigint, quantity: bigint) =>
    make(id, revision, -quantity, second, (first, last) => ({
      type: "transfer",
      sourceHoldingIds: [source],
      destinationAccountId: second,
      requestedQuantity: R(quantity),
      selection: {
        method: "specificIdentification",
        allocations: [{ holdingId: source, quantity: R(quantity) }],
      },
      policies: [
        {
          id: policyId("lot-continuity"),
          version: semanticVersion("1.0.0"),
          bookId: BOOK,
          sourceAccountId: CASH,
          destinationAccountId: second,
          validFrom: instant("2020-01-01T00:00:00Z"),
          treatment: "continuity",
        },
      ],
      governedAt: instant("2026-01-15T12:00:00Z"),
      derivation,
      allocationIdentities: [{ holdingId: source, allocationId: lotAllocationId(id) }],
      destinationIdentities: [{ sourceHoldingId: source, destinationHoldingId: destination }],
      sourcePostingId: first,
      destinationPostingId: last,
    }));
  const commands: BookCommand[] = [
    activation(),
    acquire("lot-first", 1n, 10n),
    acquire("lot-second", 2n, 7n),
    transfer("lot-transfer-first", 3n, 3n),
    transfer("lot-transfer-second", 4n, 2n),
    make("lot-disposal", 5n, -5n, accountId("income"), (first) => ({
      type: "dispose",
      holdingIds: [source],
      requestedQuantity: R(5n),
      selection: {
        method: "specificIdentification",
        allocations: [{ holdingId: source, quantity: R(5n) }],
      },
      derivation,
      identities: [{ holdingId: source, allocationId: lotAllocationId("lot-disposal") }],
      journalPostingId: first,
    })),
  ];
  return { initial, commands, source, destination, acquire };
}

// Deliberately uses the kernel's public API, not its private test fixtures.
// The ledger must preserve these workflows without knowing accounting internals.
export function allocationAndTaxWorkflow(allocationAlgorithm: "1.0.0" | "1.1.0" = "1.0.0") {
  const base = genesis();
  const version = semanticVersion("1.0.0");
  const rational = (n: bigint) => ExactRational.of(n, 1n);
  const expense = accountId("allocation-expense");
  const inputTax = accountId("recoverable-tax");
  const payable = accountId("trade-payable");
  const prepaid = accountId("prepaid-service");
  const evidence = {
    id: evidenceId("workflow-evidence"),
    sourceSystem: "ledger-conformance",
    sourceRecordId: "asset-and-purchase",
    observedAt: instant("2026-01-01T00:00:00Z"),
    contentHash: hashCanonical({ source: "asset-and-purchase" }),
  };
  const policyCore = {
    bookId: BOOK,
    version,
    validFrom: instant("2020-01-01T00:00:00Z"),
    algorithmVersion: version,
    quantizationPolicy: workflowValue(base.state.quantizationPolicies[0]),
  };
  const allocation: AllocationPolicy = {
    ...policyCore,
    algorithmVersion: semanticVersion(allocationAlgorithm),
    ...(allocationAlgorithm === "1.1.0"
      ? { postingAlgorithm: "cumulative-posted-allocation-v1" as const }
      : {}),
    id: policyId("workflow-allocation"),
    kind: "allocationSchedule",
    method: "straightLine",
    frequency: "monthly",
    convention: "fullPeriod",
    allocationAccountId: expense,
    contraAccountId: prepaid,
    capability: {
      feature: "allocationSchedule",
      status: "supported",
      implementationVersion: semanticVersion(allocationAlgorithm),
      verificationEvidenceIds: [evidence.id],
      admittedCombinations: [
        { method: "straightLine", frequency: "monthly", convention: "fullPeriod" },
      ],
    },
  };
  const component = {
    id: policyId("workflow-tax-component"),
    rate: ExactRational.of(1n, 10n),
    inclusion: "exclusive" as const,
    treatment: "inputTax" as const,
    recoverability: "recoverable" as const,
    recoverableShare: rational(1n),
    compoundOrdinal: 1n,
    compoundsOn: [],
    liabilityAccountId: payable,
    recoverableAccountId: inputTax,
  };
  const tax: TaxPolicy = {
    ...policyCore,
    id: policyId("workflow-tax"),
    kind: "taxDetermination",
    taxCode: "TEST10",
    jurisdiction: "TEST",
    roundingLevel: "lineLevel",
    components: [
      { ...component, contentHash: hashAccountingPolicyArtifact("TaxPolicyComponent", component) },
    ],
    capability: {
      feature: "taxDetermination",
      status: "supported",
      implementationVersion: version,
      verificationEvidenceIds: [evidence.id],
      admittedCombinations: [{ method: "compound" }],
    },
  };
  const initial = {
    protocol: base.protocol,
    state: createBookState(
      base.state.identity,
      [
        ...base.state.periods,
        ...(
          [
            ["february", 2n, "2026-02-01", "2026-02-28"],
            ["march", 3n, "2026-03-01", "2026-03-31"],
          ] as const
        ).map(([id, sequence, start, end]) => ({
          ...workflowValue(base.state.periods[0]),
          id: fiscalPeriodId(id),
          sequence,
          label: id,
          startsOn: localDate(start),
          endsOn: localDate(end),
        })),
      ],
      {
        ...base.state.admissionSnapshot,
        accounts: [
          ...base.state.admissionSnapshot.accounts,
          ...[expense, inputTax, payable, prepaid].map((id, index) => ({
            ...workflowValue(base.state.admissionSnapshot.accounts[0]),
            id,
            code: `workflow-${index}`,
            name: id,
            role:
              index === 0
                ? ("expense" as const)
                : index === 2
                  ? ("liability" as const)
                  : ("asset" as const),
            normalSide: index === 2 ? ("credit" as const) : ("debit" as const),
          })),
        ],
      },
      base.state.policies,
      base.state.quantizationPolicies,
      [allocation, tax],
      instant("2020-01-01T00:00:00Z"),
    ),
  };
  const derivation = (id: typeof allocation.id) => ({
    id: derivationId(`derivation-${id}`),
    policyId: id,
    policyVersion: version,
    algorithmVersion: id === allocation.id ? semanticVersion(allocationAlgorithm) : version,
    inputHash: hashCanonical({ workflow: id }),
    actorId: actorId("actor"),
    state: "approved" as const,
    recordedAt: instant("2026-01-01T00:00:00Z"),
    evidence: [evidence],
  });
  const core = (id: string, revision: bigint, date = "2026-01-15") => ({
    id: commandId(id),
    protocolVersion: version,
    bookId: BOOK,
    expectedBookRevision: revision,
    actorId: actorId("actor"),
    issuedAt: instant(`${date}T14:00:00Z`),
    completedAt: instant(`${date}T14:00:01Z`),
    committedAt: instant(`${date}T14:00:02Z`),
  });
  const template = posting("workflow-source");
  if (template.type !== "postJournal") throw new Error("Expected source journal command");
  const journal = {
    ...template.resolved.journal,
    narration: "Pay 100 for a three-month service contract",
    postings: template.resolved.journal.postings.map((p, index) => ({
      ...p,
      accountId: index === 0 ? prepaid : CASH,
    })),
  };
  const resolved = resolveJournal(
    journal,
    base.state.policies,
    base.state.identity.ownerId,
    workflowValue(base.state.quantizationPolicies[0]),
    journal.postings.map((p) => p.bookValue.amount.toRational()),
  );
  if (Array.isArray(resolved)) throw new Error("Prepayment must resolve");
  const source = sealCommand({ ...template, resolved: resolved as ResolvedTransaction });
  const reference = createCanonicalPostingReference(
    canonicalPostingReferenceId("workflow-source-reference"),
    BOOK,
    source.resolved.journal.id,
    workflowValue(source.resolved.journal.postings[0]),
    effectKey("workflow-source:journal:0"),
  );
  const schedule = allocationScheduleId("workflow-schedule");
  const recognition = allocationRecognitionId("workflow-recognition");
  const successor = allocationScheduleId("workflow-successor");
  const commands: BookCommand[] = [
    activation(),
    source,
    sealCommand({
      ...core("workflow-create", 2n),
      type: "createAllocationSchedule",
      request: {
        id: schedule,
        policyId: allocation.id,
        policyVersion: version,
        governedAt: instant("2026-01-15T14:00:00Z"),
        source: reference,
        sourceBasis: rational(100n),
        residualValue: rational(0n),
        startsOn: localDate("2026-01-01"),
        endsOn: localDate("2026-03-31"),
        derivation: derivation(allocation.id),
      },
    }),
    sealCommand({
      ...core("workflow-recognize", 3n, "2026-01-31"),
      type: "recognizeScheduledAllocation",
      request: {
        id: recognition,
        scheduleId: schedule,
        ordinal: 1n,
        governedAt: instant("2026-01-31T14:00:00Z"),
        derivation: derivation(allocation.id),
      },
    }),
    sealCommand({
      ...core("workflow-revise", 4n, "2026-02-01"),
      type: "reviseAllocationSchedule",
      request: {
        id: allocationScheduleRevisionId("workflow-revision"),
        kind: "estimateChange",
        effectiveOn: localDate("2026-02-01"),
        policyEffectiveAt: instant("2026-02-01T14:00:00Z"),
        originalScheduleId: schedule,
        priorRecognitionIds: [recognition],
        policyId: allocation.id,
        policyVersion: version,
        revisedResidualValue: rational(10n),
        successorScheduleId: successor,
        revisedEndsOn: localDate("2026-03-31"),
        evidence: [evidence],
        derivation: derivation(allocation.id),
      },
    }),
    ...(["2026-02-28", "2026-03-31"] as const).map((date, index) =>
      sealCommand({
        ...core(`workflow-successor-${index}`, 5n + BigInt(index), date),
        type: "recognizeScheduledAllocation" as const,
        request: {
          id: allocationRecognitionId(`workflow-successor-recognition-${index}`),
          scheduleId: successor,
          ordinal: BigInt(index + 1),
          governedAt: instant(`${date}T14:00:00Z`),
          derivation: derivation(allocation.id),
        },
      }),
    ),
    sealCommand({
      ...core("workflow-tax", 7n, "2026-03-31"),
      type: "postTaxedTransaction",
      request: {
        id: taxDeterminationId("workflow-tax-determination"),
        sourceTransactionId: journalId("workflow-purchase"),
        governedAt: instant("2026-03-31T14:00:00Z"),
        direction: "purchase",
        lines: [100n, 55n].map((amount, index) => ({
          lineId: `purchase-line-${index}`,
          sourcePostingId: postingId(`purchase-source-${index}`),
          counterpartyPostingId: postingId(`purchase-counterparty-${index}`),
          policyId: tax.id,
          policyVersion: version,
          statedAmount: rational(amount),
          amountIncludesTax: false,
          sourceAccountId: expense,
          payableAccountId: payable,
        })),
        derivation: derivation(tax.id),
      },
    }),
  ];
  return {
    initial,
    commands,
    accounts: { expense, inputTax, payable, prepaid },
    schedule,
    successor,
  };
}

/** Existing multi-line purchase workflow isolated from unrelated allocation state. */
export function taxWorkflow(structuralGroups = false) {
  const scenario = allocationAndTaxWorkflow();
  const state = scenario.initial.state;
  const template = scenario.commands.find((command) => command.type === "postTaxedTransaction");
  if (template?.type !== "postTaxedTransaction") throw new Error("Expected tax workflow command");
  return {
    initial: {
      protocol: scenario.initial.protocol,
      state: createBookState(
        state.identity,
        state.periods,
        state.admissionSnapshot,
        state.policies,
        state.quantizationPolicies,
        state.accountingPolicySnapshot.policies
          .filter((policy) => policy.kind === "taxDetermination")
          .map((policy) =>
            structuralGroups
              ? {
                  ...policy,
                  groupingAlgorithm: "structural-tax-groups-v1" as const,
                  roundingLevel: "documentLevel" as const,
                  algorithmVersion: semanticVersion("1.1.0"),
                  capability: {
                    ...policy.capability,
                    implementationVersion: semanticVersion("1.1.0"),
                  },
                }
              : policy,
          ),
        instant("2020-01-01T00:00:00Z"),
      ),
    },
    command: sealCommand({ ...template, expectedBookRevision: 1n }),
    accounts: scenario.accounts,
  };
}

/** The same exact command is submitted by separate processes in recovery tests. */
export function workflowTerminationCommand(
  scenario: ReturnType<typeof allocationAndTaxWorkflow>,
  expectedBookRevision = 8n,
) {
  const template = workflowValue(scenario.commands[4]);
  if (template.type !== "reviseAllocationSchedule") throw new Error("Expected revision template");
  return sealCommand({
    ...template,
    id: commandId("workflow-crash-termination"),
    expectedBookRevision,
    issuedAt: instant("2026-03-31T15:00:00Z"),
    completedAt: instant("2026-03-31T15:00:01Z"),
    committedAt: instant("2026-03-31T15:00:02Z"),
    request: {
      id: allocationScheduleRevisionId("workflow-crash-terminal"),
      kind: "termination" as const,
      effectiveOn: localDate("2026-03-31"),
      policyEffectiveAt: instant("2026-03-31T15:00:00Z"),
      originalScheduleId: scenario.successor,
      priorRecognitionIds: [
        allocationRecognitionId("workflow-successor-recognition-0"),
        allocationRecognitionId("workflow-successor-recognition-1"),
      ],
      policyId: template.request.policyId,
      policyVersion: template.request.policyVersion,
      revisedResidualValue: ExactRational.zero(),
      exactAdjustmentAmount: ExactRational.of(-10n, 1n),
      generatedEffectKey: effectKey("workflow-crash-termination:journal:0"),
      evidence: template.request.evidence,
      derivation: template.request.derivation,
    },
  });
}

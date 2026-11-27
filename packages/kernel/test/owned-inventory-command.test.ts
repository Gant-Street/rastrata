import { expect, test } from "bun:test";
import { prepareOwnedInventoryAccounting, type OwnedInventoryAccountingContext, type OwnedInventoryTransactionRequest, type OwnedInventoryOperationInput } from "../src/owned-inventory-command.ts";
import { ExactDecimal as D, ExactRational as R, identifier, commandId, effectKey, hashCanonical, canonicalAccountingValue, canonicalPolicyValue, hashAccountingPolicy,
  lotId, lotHoldingId, lotAllocationId, instant, localDate, semanticVersion, dimensionMemberId, commodityId, canonicalPostingReferenceId, prepareBookJournal, policyId,
  encodeInventoryOwnershipArtifact, decodeInventoryOwnershipArtifact, type InventoryCostPolicy, type InventoryPostedAcquisitionEntry,
  type InventoryOwnershipReadContext, type LotHolding, type Lot, type LotHoldingId, type BookState,
  createBookState, executeBookCommand, sealCommand, STRUCTURAL_SOURCE_IDENTITY_PROFILE, validateBookState,
  encodeDurableBook, decodeDurableBook, hashBookState, assertBookCommandShape, evaluateBookCommand, commitBookIntent,
  closePackageId, accountId, quantizationPolicyId, evidenceId,
  prepareBookOwnedInventory, type BookOwnedInventoryReadContext,
  isInventoryPostedReductionMovement, type QuantityOnlyInventoryReductionMovement,
  ACCOUNTING_LIMITS,
  evaluateCurrentBookCommand, type CurrentBookContext, hashLotChanges, hashCommitIntent,
  type BookCommitIntent,
  canonicalEncode, canonicalBookEffectValue, validateBookEffectTopology,
} from "../src/index.ts";
import { IDS, policy, quantizationPolicy, freshState, journal, resolved, postingReference } from "./fixtures.ts";
import { accountingDerivation, capability, pool } from "./accounting-fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

const q = (n: bigint, d = 1n) => R.of(n, d);
const inventoryPolicy: InventoryCostPolicy = { kind: "inventoryCost", id: accountingDerivation.policyId, version: accountingDerivation.policyVersion,
  bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"),
  quantizationPolicy, capability: capability("inventoryCost", "fifo"), method: "fifo", pools: [pool("inventory", "cash")], shortageTreatment: "reject" };
const policyReference = { policyId: inventoryPolicy.id, policyVersion: inventoryPolicy.version, policyContentHash: hashAccountingPolicy(inventoryPolicy) };
const coordinate = { accountId: IDS.cash, unitsCommodityId: IDS.usd, dimensionMemberIds: [],
  bookingPolicy: { policyId: policy.id, policyVersion: policy.version, policyContentHash: hashCanonical(canonicalPolicyValue(policy)) } };

function entry(id: string, basis = q(0n)): InventoryPostedAcquisitionEntry {
  const lot: Lot = { id: lotId(`lot-${id}`), bookId: IDS.book, commodityId: IDS.usd, basisCommodityId: IDS.usd,
    acquiredAt: instant("2026-01-15T12:00:00Z"), acquisitionQuantity: q(1n), acquisitionTotalBasis: basis,
    evidenceIds: accountingDerivation.evidence.map((e) => e.id) };
  const holding: LotHolding = { id: lotHoldingId(`holding-${id}`), lotId: lot.id, bookId: IDS.book, accountId: IDS.cash,
    commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: q(1n), remainingTotalBasis: basis,
    remainingValuationAllowance: q(0n), remainingCarryingAmount: basis };
  return { lot, holding, anchorId: identifier<"InventoryPostedAnchor">(`anchor-${id}`),
    movementId: identifier<"InventoryPostedMovement">(`acquire-${id}`), evidence: accountingDerivation.evidence };
}
function acquisition(entries = [entry("free")]): Extract<OwnedInventoryOperationInput, { kind: "acquisition" }> {
  return { kind: "acquisition", ordinal: 0n, id: identifier<"InventoryOperation">("acquire"), coordinate, inventoryPolicy: policyReference,
    derivation: accountingDerivation, entries };
}
function issue(id: string, ordinal = 1n): Extract<OwnedInventoryOperationInput, { kind: "issue" }> {
  return { kind: "issue", ordinal, id: identifier<"InventoryOperation">(`issue-${ordinal}`), coordinate, inventoryPolicy: policyReference,
    derivation: accountingDerivation, quantity: q(1n), identities: [{ holdingId: lotHoldingId(`holding-${id}`),
      allocationId: lotAllocationId(`allocation-${ordinal}`), movementId: identifier<"InventoryPostedMovement">(`issue-movement-${ordinal}`) }] };
}
function adopt(holding: LotHolding, ordinal = 1n, postedBalance = holding.remainingCarryingAmount): Extract<OwnedInventoryOperationInput, { kind: "adopt" }> {
  return {
    kind: "adopt", ordinal, id: identifier<"InventoryOperation">(`adopt-${ordinal}`),
    coordinate: { ...coordinate, accountId: holding.accountId }, inventoryPolicy: policyReference,
    derivation: accountingDerivation,
    entries: [{
      anchorId: identifier<"InventoryPostedAnchor">(`adopt-anchor-${ordinal}`),
      movementId: identifier<"InventoryPostedMovement">(`adopt-mov-${ordinal}`),
      holdingId: holding.id,
      evidence: accountingDerivation.evidence,
      historicalPostings: [],
    }],
    postedBalance,
  };
}
function transfer(
  sourceHoldingId: LotHoldingId,
  quantity = q(1n),
  ordinal = 1n,
  destAccountId = IDS.cash,
  extra?: Record<string, unknown>,
): Extract<OwnedInventoryOperationInput, { kind: "transfer" }> {
  return {
    kind: "transfer", ordinal, id: identifier<"InventoryOperation">(`transfer-${ordinal}`),
    coordinate, inventoryPolicy: policyReference, derivation: accountingDerivation,
    destinationCoordinate: { ...coordinate, accountId: destAccountId },
    destinationInventoryPolicy: policyReference,
    quantity,
    entries: [{
      holdingId: sourceHoldingId,
      allocationId: lotAllocationId(`xfer-alloc-${ordinal}`),
      transferOutMovementId: identifier<"InventoryPostedMovement">(`xfer-out-${ordinal}`),
      destinationAnchorId: identifier<"InventoryPostedAnchor">(`xfer-dest-anchor-${ordinal}`),
      destinationMovementId: identifier<"InventoryPostedMovement">(`xfer-dest-mov-${ordinal}`),
      destinationHoldingId: lotHoldingId(`xfer-dest-holding-${ordinal}`),
      destinationLotId: lotId(`xfer-dest-lot-${ordinal}`),
      evidence: accountingDerivation.evidence,
      ...extra,
    }],
  };
}
function fixture(operations: readonly OwnedInventoryOperationInput[] = [acquisition()]) {
  const state = freshState().state;
  const ownership: InventoryOwnershipReadContext = { bookId: IDS.book, bookRevision: 1n, assertCurrent() {},
    readCurrentHolding() { return undefined; }, readCurrentPosition() { return undefined; }, readAnchor() { return undefined; }, readPositionAfterImage() { return undefined; } };
  const context: OwnedInventoryAccountingContext = { bookId: IDS.book, commandId: commandId("owned-command"), effectKey: effectKey("owned-command:ownership:0"), bookRevision: 2n,
    accountingDate: localDate("2026-01-15"), fiscalPeriodId: IDS.period1, functionalCommodityId: IDS.usd, ownerId: IDS.owner,
    admissionSnapshot: state.admissionSnapshot, bookingPolicies: [policy], accountingPolicies: [inventoryPolicy], quantizationPolicies: [quantizationPolicy],
    journals: [], ownership, readPool() { return []; }, identityPresence() { return "absent"; }, managedMoneyScope() { return "unmanaged"; },
    latestMovementDate() { return localDate("2026-01-15"); } };
  const request: OwnedInventoryTransactionRequest = { algorithm: "cumulativePostedInventoryV1", algorithmVersion: semanticVersion(operations.some((op) => op.kind === "transfer" || op.kind === "adopt") ? "1.1.0" : "1.0.0"),
    accountingDate: context.accountingDate, governedAt: instant("2026-01-15T12:00:00Z"), fiscalPeriodId: IDS.period1, operations, resolvedJournals: [] };
  return { context, request };
}

function ready(context: OwnedInventoryAccountingContext, request: OwnedInventoryTransactionRequest) {
  const result = prepareOwnedInventoryAccounting(context, request);
  expect(result.disposition, result.disposition === "rejected" ? JSON.stringify(result.diagnostics) : "").toBe("prepared");
  if (result.disposition !== "prepared") throw new Error("Expected ownership candidate");
  return result;
}
function rejected(context: OwnedInventoryAccountingContext, request: OwnedInventoryTransactionRequest, path: string) {
  const result = prepareOwnedInventoryAccounting(context, request);
  expect(result.disposition).toBe("rejected");
  if (result.disposition !== "rejected") throw new Error("Expected rejected candidate");
  expect(result.diagnostics.map((d) => d.path)).toContain(path);
  expect(Object.keys(result).sort()).toEqual(["diagnostics", "disposition"]);
}

test("ordered free acquisition and issue yield economic allocations and no invented postings", () => {
  const f = fixture([acquisition(), issue("free")]);
  const before = hashCanonical(canonicalAccountingValue(f.request));
  const result = ready(f.context, f.request);
  expect(result.effect.journalLinkedMovements).toEqual([]);
  expect(result.effect.quantityOnlyMovements.map((m) => [m.kind, m.artifactOrdinal, m.postedAmount.toString()])).toEqual([
    ["acquisition", 2n, "0.00"], ["disposal", 3n, "0.00"],
  ]);
  expect(result.afterHoldings.map((h) => h.remainingQuantity.toString())).toEqual(["0/1"]);
  expect(result.afterPositions.map((p) => p.consumedQuantity.toString())).toEqual(["1/1"]);
  expect(result.effect.quantityOnlyMovements.every((m) => !("posting" in m))).toBe(true);
  expect(decodeInventoryOwnershipArtifact("ownershipEffect", encodeInventoryOwnershipArtifact("ownershipEffect", result.effect)).disposition).toBe("decoded");
  expect(hashCanonical(canonicalAccountingValue(f.request))).toEqual(before);
});

test("a later over-issue discards the entire acquisition candidate", () => {
  const f = fixture([acquisition(), issue("free"), issue("free", 2n)]);
  const result = prepareOwnedInventoryAccounting(f.context, f.request);
  expect(result.disposition).toBe("rejected");
  expect(Object.keys(result).sort()).toEqual(["diagnostics", "disposition"]);
  expect(ready(f.context, { ...f.request, operations: f.request.operations.slice(0, 2) }).afterHoldings[0]!.remainingQuantity.toString()).toBe("0/1");
});

test("money-bearing acquisition uses an actual admitted balanced journal and its precise posted budget", () => {
  const f = fixture([acquisition([entry("a", q(1n, 300n)), entry("b", q(1n, 300n)), entry("c", q(1n, 300n))])]);
  const raw = journal("owned-acquisition"), inventory = { ...raw.postings[0]!, units: { canonicalNumber: q(3n), commodityId: IDS.usd },
    bookValue: { amount: D.parse("0.01"), functionalCommodityId: IDS.usd }, costBasis: { totalBasis: q(1n, 100n), basisCommodityId: IDS.usd } };
  const resolvedJournal = resolved({ ...raw, postings: [inventory, { ...raw.postings[1]!, units: { canonicalNumber: q(-1n, 100n), commodityId: IDS.usd }, bookValue: { amount: D.parse("-0.01"), functionalCommodityId: IDS.usd } }] });
  const state = freshState().state;
  const booked = prepareBookJournal({ ...state, journalIdentity: () => "absent", postingIdentity: () => "absent", periodStatus: () => "open" },
    { id: f.context.commandId, bookId: IDS.book }, resolvedJournal, IDS.period1, 2n, 1n, false);
  if (!("journal" in booked)) throw new Error(JSON.stringify(booked));
  const operation = { ...f.request.operations[0]!, postingLink: { journalOrdinal: 0n, postingId: inventory.id, referenceId: canonicalPostingReferenceId("owned-acquisition-ref") } };
  const context = { ...f.context, journals: [booked] }, request = { ...f.request, operations: [operation], resolvedJournals: [resolvedJournal] };
  const result = ready(context, request);
  expect(result.effect.newAnchors.map((a) => a.postedBudget.toString())).toEqual(["0.00", "0.01", "0.00"]);
  expect(result.effect.quantityOnlyMovements).toHaveLength(2);
  expect(result.effect.journalLinkedMovements).toHaveLength(1);
  expect(result.effect.journalLinkedMovements[0]!.posting.postingId).toBe(inventory.id);
  const adjustment = resolved({ ...resolvedJournal.journal, kind: "adjustment" });
  const adjusted = prepareBookJournal({ ...state, journalIdentity: () => "absent", postingIdentity: () => "absent", periodStatus: () => "open" },
    { id: f.context.commandId, bookId: IDS.book }, adjustment, IDS.period1, 2n, 1n, false);
  if (!("journal" in adjusted)) throw new Error("Adjustment fixture rejected");
  expect(ready({ ...context, journals: [adjusted] }, { ...request, resolvedJournals: [adjustment] }).effect.newAnchors.map((a) => a.postedBudget.toString())).toEqual(["0.00", "0.01", "0.00"]);
  rejected({ ...context, journals: [{ ...booked, commandId: commandId("different") }] }, request, "ownedInventory.journals");
  rejected(context, { ...request, operations: [{ ...operation, postingLink: { ...operation.postingLink, journalOrdinal: 1n } }] }, "ownedInventory.postingLink");
  rejected({ ...context, managedMoneyScope: () => "managed" }, request, "ownedInventory.unattributedPosting");
  const wrongJournal = resolved({ ...resolvedJournal.journal, postings: resolvedJournal.journal.postings.map((p) => ({ ...p,
    bookValue: { ...p.bookValue, amount: D.of(p.bookValue.amount.coefficient * 2n, p.bookValue.amount.scale) } })) });
  const wrongBooked = prepareBookJournal({ ...state, journalIdentity: () => "absent", postingIdentity: () => "absent", periodStatus: () => "open" },
    { id: f.context.commandId, bookId: IDS.book }, wrongJournal, IDS.period1, 2n, 1n, false);
  if (!("journal" in wrongBooked)) throw new Error(JSON.stringify(wrongBooked));
  rejected({ ...context, journals: [wrongBooked] }, { ...request, resolvedJournals: [wrongJournal] }, "ownedInventory.acquisitionMoney");
  const noMoney = fixture();
  rejected(noMoney.context, { ...noMoney.request, operations: [acquisition([entry("nonzero", q(1n))])] }, "ownedInventory.acquisitionMoney");
});

test("changing a posting's units commodity cannot bypass the newly managed account money scope", () => {
  const f = fixture(), state = freshState().state, raw = journal("currency-unit-adjustment");
  const input = resolved({ ...raw, postings: [
    { ...raw.postings[0]!, units: { canonicalNumber: q(100n), commodityId: commodityId("EUR") } }, raw.postings[1]!,
  ] });
  const booked = prepareBookJournal({ ...state, journalIdentity: () => "absent", postingIdentity: () => "absent", periodStatus: () => "open" },
    { id: f.context.commandId, bookId: IDS.book }, input, IDS.period1, 2n, 1n, false);
  if (!("journal" in booked)) throw new Error(JSON.stringify(booked));
  rejected({ ...f.context, journals: [booked] }, { ...f.request, resolvedJournals: [input] }, "ownedInventory.unattributedPosting");
});

test("scope, policy hash, calendar, identities and read invalidation fail closed without partial effects", () => {
  const f = fixture(), operation = f.request.operations[0]!;
  rejected(f.context, { ...f.request, algorithm: "unknown" }, "ownedInventory.request");
  rejected(f.context, { ...f.request, operations: [{ ...operation, ordinal: 1n }] }, "ownedInventory.order");
  rejected({ ...f.context, identityPresence: () => "present" }, f.request, "ownedInventory.order");
  rejected(f.context, { ...f.request, operations: [{ ...operation, coordinate: { ...coordinate, bookingPolicy: { ...coordinate.bookingPolicy, policyContentHash: hashCanonical({ forged: true }) } } }] }, "ownedInventory.bookingPolicy");
  rejected(f.context, { ...f.request, operations: [{ ...operation, inventoryPolicy: { ...policyReference, policyContentHash: hashCanonical({ forged: true }) } }] }, "ownedInventory.policy");
  const future = entry("future");
  rejected(f.context, { ...f.request, operations: [acquisition([{ ...future, lot: { ...future.lot, acquiredAt: instant("2026-01-16T12:00:00Z") } }])] }, "ownedInventory.acquisition");
  rejected({ ...f.context, quantizationPolicies: [] }, f.request, "ownedInventory.quantization");
  rejected(f.context, { ...f.request, operations: [{ ...operation, coordinate: { ...coordinate, dimensionMemberIds: [dimensionMemberId("z"), dimensionMemberId("a")] } }] }, "ownedInventory.coordinate");
  expect(() => prepareOwnedInventoryAccounting({ ...f.context, ownership: { ...f.context.ownership, assertCurrent() { throw new Error("head invalidated"); } } }, f.request)).toThrow("head invalidated");
});

test("head invalidation during a lookup is an infrastructure failure, never a rejected accounting receipt", () => {
  const f = fixture();
  let valid = true;
  const context: OwnedInventoryAccountingContext = { ...f.context,
    ownership: { ...f.context.ownership, assertCurrent() { if (!valid) throw new Error("read head invalidated"); } },
    identityPresence() { valid = false; return "absent"; },
  };
  expect(() => prepareOwnedInventoryAccounting(context, f.request)).toThrow("read head invalidated");
  expect(ready(f.context, f.request).effect.quantityOnlyMovements).toHaveLength(1);
});

for (const scope of ["account", "legalEntity"] as const) test(`owned source and destination booking policies enforce ${scope} ownership`, () => {
  const scopedPolicy = { ...policy, scope, scopeKey: scope === "account" ? IDS.cash : IDS.owner, capability: { ...policy.capability, scope } };
  const bookingPolicy = { policyId: scopedPolicy.id, policyVersion: scopedPolicy.version, policyContentHash: hashCanonical(canonicalPolicyValue(scopedPolicy)) };
  const scopedCoordinate = { ...coordinate, bookingPolicy };
  const original = acquisition();
  const move = transfer(original.entries[0]!.holding.id);
  const operations = [{ ...original, coordinate: scopedCoordinate }, { ...move, coordinate: scopedCoordinate, destinationCoordinate: scopedCoordinate }] as const;
  const f = fixture(operations), context = { ...f.context, bookingPolicies: [scopedPolicy] };
  const result = ready(context, f.request);
  expect(result.effect.quantityOnlyMovements.map((m) => m.kind)).toEqual(["acquisition", "transferOut", "transferIn"]);
  const foreign = { ...scopedPolicy, scopeKey: "foreign" };
  const foreignCoordinate = { ...coordinate, bookingPolicy: { ...bookingPolicy, policyContentHash: hashCanonical(canonicalPolicyValue(foreign)) } };
  rejected({ ...context, bookingPolicies: [foreign] }, { ...f.request, operations: [{ ...original, coordinate: foreignCoordinate }] }, "ownedInventory.bookingPolicy");
  // A separate destination policy lets the valid source pass first.
  const destination = { ...foreign, id: policyId("destination") };
  const destinationCoordinate = { ...coordinate, bookingPolicy: { policyId: destination.id, policyVersion: destination.version, policyContentHash: hashCanonical(canonicalPolicyValue(destination)) } };
  rejected({ ...context, bookingPolicies: [scopedPolicy, destination] }, { ...f.request, operations: [operations[0]!, { ...operations[1]!, destinationCoordinate }] }, "ownedInventory.bookingPolicy");
});

test("owned command population caps are inclusive before identity and policy admission", () => {
  const f = fixture(), cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  rejected(f.context, { ...f.request, operations: Array.from({ length: cap }, () => acquisition()) }, "ownedInventory.bounds");
  const noEvidence = { ...entry("bounded"), evidence: [], lot: { ...entry("bounded").lot, evidenceIds: [] } };
  // At the command bound, permanent operation identity remains the next check.
  const atCap = acquisition(Array.from({ length: cap - 2 }, () => noEvidence));
  rejected({ ...f.context, identityPresence: () => "present" }, { ...f.request, operations: [atCap] }, "ownedInventory.order");
  const evidence = Array.from({ length: cap - 3 }, () => accountingDerivation.evidence[0]!);
  rejected({ ...f.context, identityPresence: () => "present" }, { ...f.request, operations: [acquisition([{ ...noEvidence, evidence }])] }, "ownedInventory.order");
  for (const operation of [transfer(noEvidence.holding.id, q(1n), 0n), adopt(noEvidence.holding, 0n)]) {
    const emptyEntries = operation.entries.map((e) => ({ ...e, evidence: [] }));
    const many = { ...operation, entries: Array.from({ length: cap - 2 }, () => emptyEntries[0]!) } as OwnedInventoryOperationInput;
    rejected({ ...f.context, identityPresence: () => "present" }, { ...f.request, algorithmVersion: semanticVersion("1.1.0"), operations: [many] }, "ownedInventory.order");
    const one = { ...operation, entries: [{ ...operation.entries[0]!, evidence }] } as OwnedInventoryOperationInput;
    rejected({ ...f.context, identityPresence: () => "present" }, { ...f.request, algorithmVersion: semanticVersion("1.1.0"), operations: [one] }, "ownedInventory.order");
  }
  const input = resolved(journal("bounded-journal")), state = freshState().state;
  const booked = prepareBookJournal({ ...state, journalIdentity: () => "absent", postingIdentity: () => "absent", periodStatus: () => "open" },
    { id: f.context.commandId, bookId: IDS.book }, input, IDS.period1, 2n, 1n, false);
  if (!("journal" in booked)) throw new Error("Bounded journal fixture rejected");
  rejected({ ...f.context, journals: Array.from({ length: cap }, () => booked) },
    { ...f.request, resolvedJournals: Array.from({ length: cap }, () => input) }, "ownedInventory.journals");
});

test("owned source and destination coordinates distinguish noncanonical order from unknown members", () => {
  for (const destination of [false, true]) {
    const original = acquisition(), move = transfer(original.entries[0]!.holding.id);
    for (const dimensions of [[dimensionMemberId("unknown")], [dimensionMemberId("a"), dimensionMemberId("a")]]) {
      const operations = destination ? [original, { ...move, destinationCoordinate: { ...coordinate, dimensionMemberIds: dimensions } }]
        : [{ ...original, coordinate: { ...coordinate, dimensionMemberIds: dimensions } }];
      const f = fixture(operations), result = prepareOwnedInventoryAccounting(f.context, f.request);
      expect(result.disposition).toBe("rejected");
      if (result.disposition !== "rejected") throw new Error("Invalid coordinate admitted");
      if (dimensions.length === 2) expect(result.diagnostics[0]!.path).toBe("ownedInventory.coordinate");
      else expect(result.diagnostics[0]!.code).toBe("invalid_dimension_selection");
    }
  }
});

for (const kind of ["issue", "transfer"] as const) test(`owned ${kind} honors explicit specific-lot selection`, () => {
  const selectedPolicy: InventoryCostPolicy = { ...inventoryPolicy, method: "specificIdentification", capability: capability("inventoryCost", "specificIdentification") };
  const ref = { ...policyReference, policyContentHash: hashAccountingPolicy(selectedPolicy) };
  const operation = kind === "issue" ? { ...issue("b"), specificHoldingIds: [lotHoldingId("holding-b")] }
    : { ...transfer(lotHoldingId("holding-b")), specificHoldingIds: [lotHoldingId("holding-b")], destinationInventoryPolicy: ref };
  const f = fixture([{ ...acquisition([entry("a"), entry("b")]), inventoryPolicy: ref }, { ...operation, inventoryPolicy: ref }]);
  const result = ready({ ...f.context, accountingPolicies: [selectedPolicy] }, f.request);
  expect(result.afterHoldings.find((h) => h.id === lotHoldingId("holding-a"))!.remainingQuantity.toString()).toBe("1/1");
  expect(result.afterHoldings.find((h) => h.id === lotHoldingId("holding-b"))!.remainingQuantity.toString()).toBe("0/1");
  expect(result.effect.quantityOnlyMovements.filter((m): m is QuantityOnlyInventoryReductionMovement => isInventoryPostedReductionMovement(m)).map((m) => m.quantityAllocation.holdingId)).toEqual([lotHoldingId("holding-b")]);
});

test("owned pool limits admit the exact work cap before canonical row validation", () => {
  const bad = entry("pool"), row = { lot: bad.lot, holding: { ...bad.holding, accountId: IDS.revenue } };
  for (const operation of [issue("pool", 0n), transfer(bad.holding.id, q(1n), 0n)]) {
    const f = fixture([operation]), initialWork = operation.kind === "issue" ? 3 : 4;
    const context = { ...f.context, readPool: () => Array.from({ length: ACCOUNTING_LIMITS.maxInventoryLayers - initialWork }, () => row) };
    rejected(context, f.request, "inventoryOwnership.selectionPool");
  }
});

test("owned issues and transfers admit exactly the authenticated source-work cap", () => {
  // Each historical acquisition itself fits the command work bound. The
  // later command combines two independent, hash-bound original sources.
  const population = (ACCOUNTING_LIMITS.maxInventoryLayers - 8) / 2;
  const sources = ["large-a", "large-b"].map((id, index) => {
    const base = entry(id), evidence = Array.from({ length: population }, (_, i) => ({ ...base.evidence[0]!, id: evidenceId(`${id}-${i}`) }));
    const f = fixture([acquisition([{ ...base, evidence, lot: { ...base.lot, evidenceIds: evidence.map((e) => e.id) } }])]);
    const context = { ...f.context, commandId: commandId(`historical-${id}`), effectKey: effectKey(`historical-${id}:ownership:0`), bookRevision: BigInt(index + 2),
      ownership: { ...f.context.ownership, bookRevision: BigInt(index + 1) } };
    const result = ready(context, f.request);
    return { lot: result.newLots[0]!, holding: result.afterHoldings[0]!, anchor: result.effect.newAnchors[0]!, position: result.afterPositions[0]! };
  });
  const f = fixture(), ownership: InventoryOwnershipReadContext = { ...f.context.ownership, bookRevision: 3n,
    readCurrentHolding: (id) => sources.find((s) => s.holding.id === id)?.holding,
    readCurrentPosition: (id) => sources.find((s) => s.holding.id === id)?.position,
    readAnchor: (ref) => sources.find((s) => s.anchor.id === ref.id)?.anchor,
    readPositionAfterImage: (origin) => sources.find((s) => s.position.originMovementId === origin.movementId)?.position };
  const context = { ...f.context, bookRevision: 4n, ownership, readPool: () => sources.map(({ lot, holding }) => ({ lot, holding })) };
  const dispose = { ...issue("large-a", 0n), quantity: q(2n),
    identities: sources.map((s, i) => ({ holdingId: s.holding.id, allocationId: lotAllocationId(`large-issue-${i}`), movementId: identifier<"InventoryPostedMovement">(`large-issue-${i}`) })),
    derivation: { ...accountingDerivation, evidence: [0, 1, 2].map((i) => ({ ...accountingDerivation.evidence[0]!, id: evidenceId(`issue-evidence-${i}`) })) } };
  const issued = ready(context, { ...f.request, operations: [dispose] });
  expect(issued.afterHoldings.map((h) => h.remainingQuantity.toString())).toEqual(["0/1", "0/1"]);
  const moves = sources.map((s, i) => transfer(s.holding.id, q(1n), BigInt(i)).entries[0]!);
  const move = { ...transfer(sources[0]!.holding.id, q(2n), 0n), entries: moves };
  const transferred = ready(context, { ...f.request, algorithmVersion: semanticVersion("1.1.0"), operations: [move] });
  expect(transferred.effect.quantityOnlyMovements.filter((m): m is QuantityOnlyInventoryReductionMovement => isInventoryPostedReductionMovement(m)).map((m) => m.quantityAllocation.allocatedQuantity.toString())).toEqual(["1/1", "1/1"]);
  expect(transferred.effect.journalLinkedMovements).toEqual([]);
});

test("a later issue authenticates original anchor/position and cannot adopt an unowned pool row", () => {
  const first = fixture(), acquired = ready(first.context, first.request);
  const holding = acquired.afterHoldings[0]!, position = acquired.afterPositions[0]!, anchor = acquired.effect.newAnchors[0]!, lot = acquired.newLots[0]!;
  const f = fixture([issue("free", 0n)]);
  const ownership: InventoryOwnershipReadContext = { ...f.context.ownership, bookRevision: 2n,
    readCurrentHolding: () => holding, readCurrentPosition: () => position, readAnchor: () => anchor, readPositionAfterImage: () => position };
  const context = { ...f.context, commandId: commandId("second-owned-command"), effectKey: effectKey("second-owned-command:ownership:0"), bookRevision: 3n,
    ownership, readPool: () => [{ lot, holding }] };
  const before = hashCanonical(canonicalAccountingValue({ lot, holding, position, anchor }));
  const issued = ready(context, f.request);
  expect(issued.newLots).toEqual([]);
  expect(issued.effect.newAnchors).toEqual([]);
  expect(issued.effect.quantityOnlyMovements.map((m) => [m.kind, m.artifactOrdinal])).toEqual([["disposal", 1n]]);
  expect(issued.afterHoldings[0]!.remainingQuantity.toString()).toBe("0/1");
  expect(hashCanonical(canonicalAccountingValue({ lot, holding, position, anchor }))).toEqual(before);
  rejected({ ...context, latestMovementDate: () => localDate("2026-01-16") }, f.request, "ownedInventory.issueSource");
  rejected({ ...context, ownership: { ...ownership, readCurrentPosition: () => undefined } }, f.request, "inventoryOwnership.currentSource");
  expect(() => prepareOwnedInventoryAccounting({ ...context, readPool: () => [{ lot, holding: { ...holding, remainingQuantity: q(2n) } }] }, f.request)).toThrow("Authenticated pool and holding disagree");
  const operation = f.request.operations[0]!;
  if (operation.kind !== "issue") throw new Error("Expected issue");
  rejected(context, { ...f.request, operations: [{ ...operation, identities: [{ ...operation.identities[0]!, holdingId: lotHoldingId("wrong") }] }] }, "inventoryOwnership.selectionIdentity");
});

function activatedOwnedBook(withUnmanagedAccount = false) {
  const base = freshState(), c = base.state.activeConfigurationSnapshot;
  const admission = withUnmanagedAccount ? { ...c.admissionSnapshot, accounts: [...c.admissionSnapshot.accounts,
    { ...c.admissionSnapshot.accounts[0]!, id: accountId("unmanaged-inventory"), code: "1100", name: "Unmanaged inventory" }] } : c.admissionSnapshot;
  const state = createBookState(base.state.identity, c.periods, admission, c.policies, c.quantizationPolicies, [inventoryPolicy], c.effectiveAt, STRUCTURAL_SOURCE_IDENTITY_PROFILE);
  const result = executeBookCommand(state, base.protocol, activationCommand());
  expect(result.result.disposition).toBe("committed");
  return result;
}
function ownedCommand(request: OwnedInventoryTransactionRequest, revision: bigint, id = "owned-command") {
  return sealCommand({ type: "postOwnedInventoryTransaction" as const, request, id: commandId(id), bookId: IDS.book, expectedBookRevision: revision,
    actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"), issuedAt: instant("2026-01-15T13:00:00Z"),
    completedAt: instant("2026-01-15T13:00:01Z"), committedAt: instant("2026-01-15T13:00:02Z") });
}

test("owned 1.2 records only changed lots and holdings, preserving legacy replay and exact current admission", () => {
  const initial = activatedOwnedBook(), f = fixture([acquisition(), issue("free")]);
  const command = ownedCommand({ ...f.request, algorithmVersion: semanticVersion("1.2.0") }, 1n);
  const s = initial.state;
  const inputs: CurrentBookContext = {
    header: { identity: s.identity, financialIdentityHash: s.financialIdentityHash, status: s.status,
      bookRevision: s.bookRevision, latestPostingSequence: s.latestPostingSequence,
      configurationRevision: s.configurationRevision, configurationHash: s.configurationHash },
    configuration: s.activeConfigurationSnapshot, opening: s.openingBoundary!, activationIdentity: s.financialIdentityHash,
    previousRevision: s.revisions.at(-1)!, retainedCommand: () => null,
    journalIdentity: () => "absent", postingIdentity: () => "absent", periodStatus: () => "open",
    overdueRemeasurement: () => null, managedMoneyScope: scope => f.context.managedMoneyScope(scope),
    ownedInventoryFacts: { ownership: f.context.ownership, readPool: f.context.readPool,
      identityPresence: f.context.identityPresence, latestMovementDate: f.context.latestMovementDate,
      hasLiveUnownedStock: () => false, postedMoneyBalance: () => R.zero() },
  };
  const full = executeBookCommand(s, initial.protocol, command);
  expect(full.result.disposition).toBe("committed");
  const current = evaluateCurrentBookCommand(inputs, command);
  expect(current.result).toEqual(full.result);
  expect(current.effects).toEqual(full.intent?.effects);
  expect(current.revision).toEqual(full.state.revisions.at(-1));
  expect(current.effects?.map(e => e.type)).toEqual(["inventoryOwnership", "lotChanges"]);
  expect(full.state.lots).toHaveLength(1);
  expect(full.state.lotHoldings[0]!.remainingQuantity.toString()).toBe("0/1");
  expect(full.state.journals).toHaveLength(0);
  expect(full.state.lotAllocations).toHaveLength(0);
  expect(validateBookState(full.state)).toEqual([]);
  expect(() => evaluateCurrentBookCommand({ ...inputs, ownedInventoryFacts: undefined } as never, command)).toThrow("Missing current inventory ownership evidence");
  expect(() => evaluateCurrentBookCommand(inputs, ownedCommand(f.request, 1n))).toThrow("Unsupported current-state command");
  expect(evaluateCurrentBookCommand({ ...inputs, ownedInventoryFacts: { ...inputs.ownedInventoryFacts!, hasLiveUnownedStock: () => true } }, command).result.disposition).toBe("rejected");
  expect(evaluateCurrentBookCommand({ ...inputs, retainedCommand: () => full.protocol.retainedResults.at(-1)!,
    get ownedInventoryFacts(): never { throw new Error("Unexpected fresh inventory read"); } }, command).result.disposition).toBe("replayed");

  // Alter an after-image AND recompute its intrinsic and intent hashes. The
  // authoritative ownership preparation must still reject the fabricated stock.
  const originalIntent = full.intent!;
  const changes = originalIntent.effects.find(e => e.type === "lotChanges")!;
  const forgedHoldings = changes.changes.holdings.map(h => ({ ...h, remainingQuantity: q(1n) }));
  const forgedEffects = originalIntent.effects.map(e => e.type !== "lotChanges" ? e : {
    ...e, changes: { ...e.changes, holdings: forgedHoldings, contentHash: hashLotChanges(e.changes.lots, forgedHoldings) },
  });
  const rehash = (intent: BookCommitIntent): BookCommitIntent => ({ ...intent, canonicalHash: hashCommitIntent(intent.command,
    intent.expectedBookRevision, intent.nextBookRevision, intent.resultingPostingSequence, intent.expectedConfigurationRevision,
    intent.nextConfigurationRevision, intent.resultingConfigurationHash, intent.effects) });
  expect(commitBookIntent(s, initial.protocol, rehash({ ...originalIntent, effects: forgedEffects })).result.disposition).toBe("rejected");
  const badHash = originalIntent.effects.map(e => e.type !== "lotChanges" ? e : { ...e, changes: { ...e.changes, contentHash: hashCanonical({ bad: true }) } });
  expect(commitBookIntent(s, initial.protocol, rehash({ ...originalIntent, effects: badHash })).result.disposition).toBe("rejected");

  let aggregate = initial;
  const legacy = ownedCommand(fixture().request, 1n, "legacy-acquisition");
  aggregate = executeBookCommand(aggregate.state, aggregate.protocol, legacy);
  const legacyBytes = encodeDurableBook({ state: aggregate.state, protocol: aggregate.protocol });
  const drained = ownedCommand({ ...fixture([issue("free", 0n)]).request, algorithmVersion: semanticVersion("1.2.0") }, 2n, "drain-legacy");
  aggregate = executeBookCommand(aggregate.state, aggregate.protocol, drained);
  expect(aggregate.result.disposition).toBe("committed");
  expect(aggregate.intent?.effects.find(e => e.type === "lotChanges")?.changes.lots).toEqual([]);
  expect(aggregate.state.lotHoldings[0]!.remainingQuantity.toString()).toBe("0/1");
  const before = aggregate;
  const nextOp = { ...acquisition([entry("new")]), id: identifier<"InventoryOperation">("new-acquisition") };
  const next = ownedCommand({ ...fixture([nextOp]).request, algorithmVersion: semanticVersion("1.2.0") }, 3n, "new-acquisition");
  aggregate = executeBookCommand(before.state, before.protocol, next);
  expect(aggregate.result.disposition).toBe("committed");
  const delta = aggregate.intent?.effects.find(e => e.type === "lotChanges")?.changes;
  expect(delta?.lots.map(l => l.id)).toEqual([lotId("lot-new")]);
  expect(delta?.holdings.map(h => h.id)).toEqual([lotHoldingId("holding-new")]);
  expect(aggregate.state.lots).toHaveLength(2);
  expect(aggregate.state.lotHoldings.map(h => h.remainingQuantity.toString())).toEqual(["0/1", "1/1"]);
  const encoded = encodeDurableBook({ state: aggregate.state, protocol: aggregate.protocol });
  const restored = decodeDurableBook(encoded);
  expect(restored.disposition, restored.disposition === "rejected" ? restored.message : "").toBe("decoded");
  if (restored.disposition !== "decoded") throw new Error("Expected mixed-format recovery");
  expect(encodeDurableBook(restored.aggregate)).toBe(encoded);
  expect(executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, drained).result.disposition).toBe("replayed");
  const old = decodeDurableBook(legacyBytes);
  expect(old.disposition).toBe("decoded");
  if (old.disposition !== "decoded") throw new Error("Expected legacy recovery");
  expect(encodeDurableBook(old.aggregate)).toBe(legacyBytes);
  const lastOp = { ...acquisition([entry("legacy-after")]), id: identifier<"InventoryOperation">("legacy-after") };
  const legacyAfter = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol,
    ownedCommand(fixture([lastOp]).request, 4n, "legacy-after"));
  expect(legacyAfter.result.disposition).toBe("committed");
  expect(legacyAfter.intent?.effects.at(-1)?.type).toBe("lotState");
  expect(legacyAfter.state.lotHoldings.map(h => h.remainingQuantity.toString())).toEqual(["0/1", "1/1", "1/1"]);
  expect(decodeDurableBook(encodeDurableBook({ state: legacyAfter.state, protocol: legacyAfter.protocol })).disposition).toBe("decoded");
  const unknownFieldState = { ...full.state, revisions: full.state.revisions.map(revision => ({ ...revision,
    effects: revision.effects.map(effect => effect.type !== "lotChanges" ? effect : { ...effect,
      changes: { ...effect.changes, allocations: [] } }),
  })) };
  const unknownField = decodeDurableBook(encodeDurableBook({ state: unknownFieldState, protocol: full.protocol }));
  expect(unknownField.disposition).toBe("rejected");
  if (unknownField.disposition !== "rejected") throw new Error("Expected strict delta schema rejection");
  expect(unknownField.message).toContain("allocations is not admitted");
  expect(validateBookState({ ...aggregate.state, lotHoldings: before.state.lotHoldings,
    contentHash: hashBookState({ ...aggregate.state, lotHoldings: before.state.lotHoldings }) }).length).toBeGreaterThan(0);
});

test("quantity-only ownership dates constrain configuration admission and effect validation", () => {
  const active = activatedOwnedBook();
  const owned = executeBookCommand(active.state, active.protocol,
    ownedCommand({ ...fixture().request, algorithmVersion: semanticVersion("1.2.0") }, 1n));
  expect(owned.result.disposition).toBe("committed");
  expect(owned.state.journals).toHaveLength(0);
  const command = sealCommand({ type: "replaceConfiguration" as const, id: commandId("after-free-stock"),
    bookId: IDS.book, expectedBookRevision: 2n, expectedConfigurationRevision: owned.state.configurationRevision,
    actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"), issuedAt: instant("2026-01-15T14:00:00Z"),
    completedAt: instant("2026-01-15T14:00:01Z"), committedAt: instant("2026-01-15T14:00:02Z"),
    effectiveOn: localDate("2026-01-16"), periods: owned.state.periods,
    admissionSnapshot: owned.state.admissionSnapshot, policies: owned.state.policies,
    quantizationPolicies: owned.state.quantizationPolicies, accountingPolicies: owned.state.accountingPolicySnapshot.policies });
  const early = sealCommand({ ...command, effectiveOn: localDate("2026-01-15") });
  const rejected = executeBookCommand(owned.state, owned.protocol, early);
  expect(rejected.result.disposition).toBe("rejected");
  expect(rejected.result.diagnostics[0]?.code).toBe("fiscal_period_admission");
  const changed = executeBookCommand(owned.state, owned.protocol, command);
  expect(changed.result.disposition).toBe("committed");
  const forged = { ...changed.intent!, command: early, effects: changed.intent!.effects.map(effect =>
    effect.type === "configuration" ? { ...effect, effectiveOn: early.effectiveOn } : effect) };
  expect(validateBookEffectTopology(owned.state, forged).length).toBeGreaterThan(0);
  expect(decodeDurableBook(encodeDurableBook({ state: changed.state, protocol: changed.protocol })).disposition).toBe("decoded");
});

test("owned changes payload is independent of retained untouched lots", () => {
  const payloads: Uint8Array[] = [];
  for (const count of [1, 100]) {
    const initial = activatedOwnedBook();
    const seed = ownedCommand(fixture([acquisition(Array.from({ length: count }, (_, i) => entry(`seed-${i}`)))]).request, 1n, "seed");
    const seeded = executeBookCommand(initial.state, initial.protocol, seed);
    expect(seeded.result.disposition).toBe("committed");
    const operation = { ...acquisition([entry("target")]), id: identifier<"InventoryOperation">("target-acquisition") };
    const command = ownedCommand({ ...fixture([operation]).request, algorithmVersion: semanticVersion("1.2.0") }, 2n, "target");
    const result = executeBookCommand(seeded.state, seeded.protocol, command);
    expect(result.result.disposition).toBe("committed");
    const changes = result.intent!.effects.find(effect => effect.type === "lotChanges")!;
    expect(changes.changes.lots).toHaveLength(1);
    expect(changes.changes.holdings).toHaveLength(1);
    expect(result.state.lotHoldings).toHaveLength(count + 1);
    payloads.push(canonicalEncode(canonicalBookEffectValue(changes)));
    expect(validateBookState(result.state)).toHaveLength(0);
  }
  expect(payloads[1]).toEqual(payloads[0]);
  expect(payloads[0]!.byteLength).toBeLessThan(2_000);
});

test("shared owned-command preparation preserves guards, pending identities and physical-head failure", () => {
  const initial = activatedOwnedBook(), f = fixture();
  const command = ownedCommand(f.request, 1n);
  const context: BookOwnedInventoryReadContext = {
    ...initial.state, executionProfile: STRUCTURAL_SOURCE_IDENTITY_PROFILE,
    ownership: f.context.ownership, readPool: f.context.readPool,
    identityPresence: f.context.identityPresence, managedMoneyScope: f.context.managedMoneyScope,
    latestMovementDate: f.context.latestMovementDate,
    hasLiveUnownedStock: () => false, postedMoneyBalance: () => R.zero(),
    periodStatus: () => "open", journalIdentity: () => "absent", postingIdentity: () => "absent",
  };
  const prepared = prepareBookOwnedInventory(context, command);
  expect("journals" in prepared).toBe(true);
  if (!("journals" in prepared)) throw new Error("Expected shared preparation");
  expect(prepared.ownership).toEqual(executeBookCommand(initial.state, initial.protocol, command).state.inventoryOwnershipEffects![0]!);
  expect(() => prepareBookOwnedInventory({ ...context, hasLiveUnownedStock: () => undefined as never }, command)).toThrow("Incomplete unowned inventory evidence");
  expect(() => prepareBookOwnedInventory({ ...context, managedMoneyScope: () => "unknown" as never }, command)).toThrow("Incomplete managed inventory scope evidence");
  expect(() => prepareBookOwnedInventory({ ...context, ownership: { ...context.ownership, bookRevision: 2n } }, command)).toThrow("Owned inventory preparation scope changed");
  const first = journal("pending-owned-a"), second = journal("pending-owned-b");
  const repeatedPosting = ownedCommand({ ...f.request, resolvedJournals: [resolved(first), resolved({ ...second,
    postings: second.postings.map((posting, index) => ({ ...posting, id: first.postings[index]!.id })) })] }, 1n);
  const duplicate = prepareBookOwnedInventory(context, repeatedPosting);
  expect("journals" in duplicate).toBe(false);
  if ("journals" in duplicate) throw new Error("Expected duplicate posting rejection");
  expect(duplicate[0]?.code).toBe("canonical_identity_conflict");
  expect(duplicate[0]?.path).toBe("resolved.journal.postings");
  let live = true;
  expect(() => prepareBookOwnedInventory({ ...context,
    hasLiveUnownedStock: () => { live = false; return true; },
    ownership: { ...context.ownership, assertCurrent: () => { if (!live) throw new Error("physical head changed"); } },
  }, command)).toThrow("physical head changed");
});

test("canonical free inventory commits economic allocations and survives durable round-trip and exact retry", () => {
  const initial = activatedOwnedBook(), f = fixture([acquisition(), issue("free")]);
  const command = ownedCommand(f.request, initial.state.bookRevision);
  expect(() => assertBookCommandShape(command)).not.toThrow();
  const commit = executeBookCommand(initial.state, initial.protocol, command);
  expect(commit.result.disposition, JSON.stringify(commit.result.diagnostics)).toBe("committed");
  expect(commit.state.bookRevision).toBe(2n);
  expect(commit.state.latestPostingSequence).toBe(0n);
  expect(commit.state.configurationRevision).toBe(0n);
  expect(commit.state.journals).toEqual([]);
  expect(commit.state.lotAllocations).toEqual([]); // No fake legacy posting-linked allocation.
  expect(commit.state.inventoryOwnershipEffects).toHaveLength(1);
  expect(commit.state.inventoryOwnershipEffects![0]!.quantityOnlyMovements).toHaveLength(2);
  expect(commit.state.lotHoldings[0]!.remainingQuantity.toString()).toBe("0/1");
  expect(validateBookState(commit.state)).toEqual([]);
  const encoded = encodeDurableBook({ state: commit.state, protocol: commit.protocol }), restored = decodeDurableBook(encoded);
  expect(restored.disposition, restored.disposition === "rejected" ? restored.message : "").toBe("decoded");
  if (restored.disposition !== "decoded") throw new Error("Expected durable ownership book");
  expect(encodeDurableBook(restored.aggregate)).toBe(encoded);
  const retried = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, command);
  expect(retried.result.disposition).toBe("replayed");
  expect(retried.result.resultHash).toEqual(commit.result.resultHash);
  expect(encodeDurableBook({ state: retried.state, protocol: retried.protocol })).toBe(encoded);
  const { inventoryOwnershipEffects: _removed, ...withoutOwnership } = commit.state;
  const corrupt = { protocol: commit.protocol, state: { ...withoutOwnership, contentHash: hashBookState(withoutOwnership) } };
  const invalid = decodeDurableBook(encodeDurableBook(corrupt));
  expect(invalid.disposition).toBe("rejected");
  if (invalid.disposition !== "rejected") throw new Error("Expected ownership projection rejection");
  expect(invalid.message).toBe("Ownership projection must exactly reproduce immutable revision effects without implicit legacy adoption");
});

for (const version of ["1.0.0", "1.2.0"]) test(`canonical penny inventory ${version} conserves actual journal money through three separately committed issues`, () => {
  let aggregate = activatedOwnedBook();
  const raw = journal("canonical-penny-acquisition");
  const input = resolved({ ...raw, postings: [
    { ...raw.postings[0]!, units: { canonicalNumber: q(3n), commodityId: IDS.usd },
      bookValue: { amount: D.parse("0.01"), functionalCommodityId: IDS.usd },
      costBasis: { totalBasis: q(1n, 100n), basisCommodityId: IDS.usd } },
    { ...raw.postings[1]!, units: { canonicalNumber: q(-1n, 100n), commodityId: IDS.usd },
      bookValue: { amount: D.parse("-0.01"), functionalCommodityId: IDS.usd } },
  ] });
  const operation = { ...acquisition([entry("a", q(1n, 300n)), entry("b", q(1n, 300n)), entry("c", q(1n, 300n))]),
    postingLink: { journalOrdinal: 0n, postingId: raw.postings[0]!.id, referenceId: canonicalPostingReferenceId("canonical-penny-acquisition-ref") } };
  const acquire = ownedCommand({ ...fixture().request, algorithmVersion: semanticVersion(version), operations: [operation], resolvedJournals: [input] }, 1n);
  aggregate = executeBookCommand(aggregate.state, aggregate.protocol, acquire);
  expect(aggregate.result.disposition, JSON.stringify(aggregate.result.diagnostics)).toBe("committed");
  expect(aggregate.state.inventoryOwnershipEffects![0]!.newAnchors.map((a) => a.postedBudget.toString())).toEqual(["0.00", "0.01", "0.00"]);
  expect(validateBookState(aggregate.state)).toEqual([]);
  const originalBytes = encodeDurableBook({ state: aggregate.state, protocol: aggregate.protocol });
  for (const [index, id] of ["a", "b", "c"].entries()) {
    const disposal = journal(`canonical-penny-issue-${id}`);
    const disposalJournal = resolved({ ...disposal, postings: [
      { ...disposal.postings[0]!, units: { canonicalNumber: q(-1n), commodityId: IDS.usd },
        bookValue: { amount: D.parse("-0.01"), functionalCommodityId: IDS.usd },
        costBasis: { totalBasis: q(-1n, 300n), basisCommodityId: IDS.usd } },
      { ...disposal.postings[1]!, units: { canonicalNumber: q(1n, 100n), commodityId: IDS.usd },
        bookValue: { amount: D.parse("0.01"), functionalCommodityId: IDS.usd } },
    ] });
    const selected = issue(id, 0n);
    if (selected.kind !== "issue") throw new Error("Expected issue input");
    const request = { ...fixture().request, algorithmVersion: semanticVersion(version), operations: [{ ...selected,
      id: identifier<"InventoryOperation">(`canonical-issue-${id}`),
      identities: [{ holdingId: lotHoldingId(`holding-${id}`), allocationId: lotAllocationId(`canonical-allocation-${id}`),
        movementId: identifier<"InventoryPostedMovement">(`canonical-issue-movement-${id}`) }],
      ...(id === "b" ? { postingLink: { journalOrdinal: 0n, postingId: disposal.postings[0]!.id,
        referenceId: canonicalPostingReferenceId("canonical-penny-issue-ref") } } : {}),
    }], resolvedJournals: id === "b" ? [disposalJournal] : [] };
    const command = ownedCommand(request, aggregate.state.bookRevision, `canonical-issue-${id}`);
    aggregate = executeBookCommand(aggregate.state, aggregate.protocol, command);
    expect(aggregate.result.disposition, JSON.stringify(aggregate.result.diagnostics)).toBe("committed");
    expect(aggregate.state.bookRevision).toBe(BigInt(index + 3));
    expect(aggregate.state.latestPostingSequence).toBe(id === "a" ? 1n : 2n);
    expect(validateBookState(aggregate.state)).toEqual([]);
    const bytes = encodeDurableBook({ state: aggregate.state, protocol: aggregate.protocol });
    const restored = decodeDurableBook(bytes);
    expect(restored.disposition, restored.disposition === "rejected" ? restored.message : "").toBe("decoded");
    if (restored.disposition !== "decoded") throw new Error("Expected penny ownership recovery");
    const retried = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, command);
    expect(retried.result.disposition).toBe("replayed");
    expect(retried.result.resultHash).toEqual(aggregate.result.resultHash);
    expect(encodeDurableBook({ state: retried.state, protocol: retried.protocol })).toBe(bytes);
  }
  const cash = aggregate.state.journals.flatMap((j) => j.journal.postings).filter((p) => p.accountId === IDS.cash)
    .reduce((sum, p) => sum.add(p.bookValue.amount.toRational()), q(0n));
  expect(cash.toString()).toBe("0/1");
  expect(aggregate.state.lotHoldings.map((h) => [h.remainingQuantity.toString(), h.remainingCarryingAmount.toString()])).toEqual([
    ["0/1", "0/1"], ["0/1", "0/1"], ["0/1", "0/1"],
  ]);
  expect(aggregate.state.lotAllocations).toEqual([]);
  expect(aggregate.state.inventoryOwnershipEffects).toHaveLength(4);
  expect(decodeDurableBook(originalBytes).disposition).toBe("decoded");
  // Exhausting stock does not turn the money scope back into an unmanaged account.
  const denied = executeBookCommand(aggregate.state, aggregate.protocol, sealCommand({ type: "postJournal", id: commandId("after-depletion"),
    bookId: IDS.book, actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"), expectedBookRevision: aggregate.state.bookRevision,
    issuedAt: instant("2026-01-16T00:00:00Z"), completedAt: instant("2026-01-16T00:00:01Z"), committedAt: instant("2026-01-16T00:00:02Z"),
    resolved: resolved(journal("after-depletion-journal")) }));
  expect(denied.result.disposition).toBe("rejected");
  expect(denied.result.diagnostics.map((d) => d.path)).toContain("command.inventoryOwnership");
  expect(denied.state).toBe(aggregate.state);
});

test("ownership is explicit, rejectable and cannot be smuggled through a mutated intent or generic posting", () => {
  const initial = activatedOwnedBook(), f = fixture();
  const command = ownedCommand(f.request, initial.state.bookRevision);
  const evaluated = evaluateBookCommand(initial.state, initial.protocol, command);
  expect(evaluated.disposition).toBe("ready");
  if (evaluated.disposition !== "ready") throw new Error("Expected ownership intent");
  const forged = { ...evaluated.intent, effects: evaluated.intent.effects.filter((e) => e.type !== "inventoryOwnership") };
  const denied = commitBookIntent(initial.state, initial.protocol, forged);
  expect(denied.result.disposition).toBe("rejected");
  expect(denied.state).toBe(initial.state);
  const invalidOrigin = commitBookIntent(initial.state, initial.protocol, { ...evaluated.intent,
    effects: evaluated.intent.effects.map((e) => e.type === "inventoryOwnership" ? { ...e, value: { ...e.value, bookRevision: 999n } } : e) });
  expect(invalidOrigin.result.disposition).toBe("rejected");
  expect(invalidOrigin.result.diagnostics.map((d) => d.path)).toContain("intent.effects[0].inventoryOwnership");
  expect(invalidOrigin.state).toBe(initial.state);
  const committed = executeBookCommand(initial.state, initial.protocol, command);
  expect(committed.result.disposition).toBe("committed");
  const posting = sealCommand({ type: "postJournal" as const, bookId: IDS.book, actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"),
    expectedBookRevision: committed.state.bookRevision, id: commandId("raw-post"), resolved: resolved(journal("raw-owned-account")),
    issuedAt: instant("2026-01-16T00:00:00Z"), completedAt: instant("2026-01-16T00:00:01Z"), committedAt: instant("2026-01-16T00:00:02Z") });
  const rejectedPosting = executeBookCommand(committed.state, committed.protocol, posting);
  expect(rejectedPosting.result.disposition).toBe("rejected");
  expect(rejectedPosting.result.diagnostics[0]!.path).toBe("command.inventoryOwnership");
  expect(rejectedPosting.state).toBe(committed.state);
  const invalid = ownedCommand({ ...f.request, algorithm: "unsupported" }, initial.state.bookRevision, "unsupported-owned");
  const rejectedCommand = executeBookCommand(initial.state, initial.protocol, invalid);
  expect(rejectedCommand.result.disposition).toBe("rejected");
  expect(rejectedCommand.state).toBe(initial.state);
  expect(decodeDurableBook(encodeDurableBook({ state: rejectedCommand.state, protocol: rejectedCommand.protocol })).disposition).toBe("decoded");
  const badShape = { ...command, request: { ...command.request, positions: [] } };
  expect(() => assertBookCommandShape(badShape)).toThrow();
});

test("owned admission requires structural source identity, opening dates and explicit legacy-stock adoption", () => {
  const base = freshState(), legacy = executeBookCommand(base.state, base.protocol, activationCommand());
  const refusedProfile = executeBookCommand(legacy.state, legacy.protocol, ownedCommand(fixture().request, 1n, "legacy-profile-owned"));
  expect(refusedProfile.result.disposition).toBe("rejected");
  expect(refusedProfile.result.diagnostics.map((d) => d.path)).toContain("command.request.algorithm");
  expect(refusedProfile.state).toBe(legacy.state);
  const initial = activatedOwnedBook();
  const beforeOpening = executeBookCommand(initial.state, initial.protocol, ownedCommand({ ...fixture().request,
    accountingDate: localDate("2025-12-31") }, 1n, "before-opening-owned"));
  expect(beforeOpening.result.disposition).toBe("rejected");
  expect(beforeOpening.result.diagnostics.map((d) => d.path)).toContain("command.request.accountingDate");
  expect(beforeOpening.state).toBe(initial.state);
  const stock = entry("legacy", q(100n)), raw = journal("legacy-inventory-acquisition");
  const common = { bookId: IDS.book, actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"),
    issuedAt: instant("2026-01-15T13:00:00Z"), completedAt: instant("2026-01-15T13:00:01Z"), committedAt: instant("2026-01-15T13:00:02Z") };
  const legacyAcquire = sealCommand({ ...common, type: "postJournal", id: commandId("legacy-inventory-acquisition"), expectedBookRevision: 1n,
    resolved: resolved({ ...raw, postings: [{ ...raw.postings[0]!, units: { canonicalNumber: q(1n), commodityId: IDS.usd },
      costBasis: { totalBasis: q(100n), basisCommodityId: IDS.usd } }, raw.postings[1]!] }),
    lotOperations: [{ type: "acquire", lot: stock.lot, holding: stock.holding, journalPostingId: raw.postings[0]!.id }] });
  const acquired = executeBookCommand(initial.state, initial.protocol, legacyAcquire);
  expect(acquired.result.disposition, JSON.stringify(acquired.result.diagnostics)).toBe("committed");
  const adoption = executeBookCommand(acquired.state, acquired.protocol, ownedCommand(fixture().request, 2n, "implicit-adoption"));
  expect(adoption.result.disposition).toBe("rejected");
  expect(adoption.result.diagnostics.map((d) => d.path)).toContain("command.request.operations");
  expect(adoption.state).toBe(acquired.state);
  expect(adoption.state.inventoryOwnershipEffects).toBeUndefined();

  const unmanaged = executeBookCommand(initial.state, initial.protocol, sealCommand({ ...common, type: "postJournal",
    id: commandId("unowned-money"), expectedBookRevision: 1n, resolved: resolved(raw) }));
  expect(unmanaged.result.disposition).toBe("committed");
  expect(unmanaged.state.lotHoldings).toEqual([]);
  const strand = executeBookCommand(unmanaged.state, unmanaged.protocol, ownedCommand(fixture().request, 2n, "stranded-unowned-money"));
  expect(strand.result.disposition).toBe("rejected");
  expect(strand.result.diagnostics.map((d) => d.path)).toContain("command.request.ownershipOpeningBalance");
  expect(strand.state).toBe(unmanaged.state);

  const owned = executeBookCommand(initial.state, initial.protocol, ownedCommand({ ...fixture().request,
    operations: [{ ...acquisition([entry("free", q(100n))]), postingLink: { journalOrdinal: 0n, postingId: raw.postings[0]!.id,
      referenceId: canonicalPostingReferenceId("generic-guard-acquisition-ref") } }], resolvedJournals: [legacyAcquire.resolved] }, 1n));
  expect(owned.result.disposition).toBe("committed");
  const additional = journal("second-owned-acquisition");
  const secondOwned = executeBookCommand(owned.state, owned.protocol, ownedCommand({ ...fixture().request,
    operations: [{ ...acquisition([entry("second", q(100n))]), id: identifier<"InventoryOperation">("second-owned-acquisition"),
      postingLink: { journalOrdinal: 0n, postingId: additional.postings[0]!.id, referenceId: canonicalPostingReferenceId("second-owned-ref") } }],
    resolvedJournals: [resolved({ ...additional, postings: [{ ...additional.postings[0]!, units: { canonicalNumber: q(1n), commodityId: IDS.usd },
      costBasis: { totalBasis: q(100n), basisCommodityId: IDS.usd } }, additional.postings[1]!] })],
  }, 2n, "second-owned-acquisition"));
  expect(secondOwned.result.disposition, JSON.stringify(secondOwned.result.diagnostics)).toBe("committed");
  expect(secondOwned.state.inventoryOwnershipEffects).toHaveLength(2);
  expect(secondOwned.state.journals).toHaveLength(2);
  expect(secondOwned.state.lotHoldings.map((holding) => holding.remainingCarryingAmount.toString())).toEqual(["100/1", "100/1"]);
  expect(validateBookState(secondOwned.state)).toEqual([]);
  const disposal = journal("generic-owned-disposal");
  const disposalCommand = sealCommand({ ...common, type: "postJournal", id: commandId("generic-owned-disposal"), expectedBookRevision: 2n,
    resolved: resolved({ ...disposal, postings: [
      { ...disposal.postings[0]!, units: { canonicalNumber: q(-1n), commodityId: IDS.usd }, bookValue: { amount: D.parse("-100.00"), functionalCommodityId: IDS.usd },
        costBasis: { totalBasis: q(-100n), basisCommodityId: IDS.usd } },
      { ...disposal.postings[1]!, units: { canonicalNumber: q(100n), commodityId: IDS.usd }, bookValue: { amount: D.parse("100.00"), functionalCommodityId: IDS.usd } },
    ] }), lotOperations: [{ type: "dispose", holdingIds: [lotHoldingId("holding-free")], requestedQuantity: q(1n),
      selection: { method: "specificIdentification", allocations: [{ holdingId: lotHoldingId("holding-free"), quantity: q(1n) }] }, derivation: accountingDerivation,
      identities: [{ holdingId: lotHoldingId("holding-free"), allocationId: lotAllocationId("generic-owned-allocation") }], journalPostingId: disposal.postings[0]!.id }],
  });
  const disposed = executeBookCommand(owned.state, owned.protocol, disposalCommand);
  expect(disposed.result.disposition).toBe("rejected");
  expect(disposed.result.diagnostics.map((d) => d.path)).toContain("command.inventoryOwnership");
  expect(disposed.state).toBe(owned.state);
  expect(disposed.state.lotHoldings[0]!.remainingQuantity.toString()).toBe("1/1");

  const legacyDispose = sealCommand({ ...disposalCommand, lotOperations: [{ ...disposalCommand.lotOperations[0]!,
    holdingIds: [stock.holding.id], selection: { method: "specificIdentification", allocations: [{ holdingId: stock.holding.id, quantity: q(1n) }] },
    identities: [{ holdingId: stock.holding.id, allocationId: lotAllocationId("generic-owned-allocation") }],
  }] });
  const drained = executeBookCommand(acquired.state, acquired.protocol, legacyDispose);
  expect(drained.result.disposition, JSON.stringify(drained.result.diagnostics)).toBe("committed");
  const newStock = executeBookCommand(drained.state, drained.protocol, ownedCommand(fixture().request, 3n, "owned-after-legacy-exhaustion"));
  expect(newStock.result.disposition).toBe("committed");
  expect(newStock.state.lotAllocations).toEqual(drained.state.lotAllocations);
  const ownedIssue = issue("free", 0n);
  if (ownedIssue.kind !== "issue") throw new Error("Expected issue input");
  const collision = executeBookCommand(newStock.state, newStock.protocol, ownedCommand({ ...fixture().request,
    operations: [{ ...ownedIssue, identities: [{ ...ownedIssue.identities[0]!, allocationId: lotAllocationId("generic-owned-allocation") }] }] }, 4n, "legacy-allocation-collision"));
  expect(collision.result.disposition).toBe("rejected");
  expect(collision.result.diagnostics.map((d) => d.path)).toContain("ownedInventory.issueIdentity");
  expect(collision.state).toBe(newStock.state);
  const exhausted = executeBookCommand(collision.state, collision.protocol, ownedCommand(fixture([ownedIssue]).request, 4n, "owned-after-legacy-issue"));
  expect(exhausted.result.disposition).toBe("committed");
  expect(exhausted.state.lotAllocations).toEqual(drained.state.lotAllocations);
  expect(exhausted.state.inventoryOwnershipEffects).toHaveLength(2);
  expect(validateBookState(exhausted.state)).toEqual([]);
  expect(decodeDurableBook(encodeDurableBook({ state: exhausted.state, protocol: exhausted.protocol })).disposition).toBe("decoded");
});

test("later issues preserve explicit accounting dates and replay across close, rejection and reopen", () => {
  const initial = activatedOwnedBook();
  const acquireRequest = { ...fixture().request, accountingDate: localDate("2026-01-14") };
  // Accounting date is explicit, not inferred from the January 15 economic instant.
  const acquired = executeBookCommand(initial.state, initial.protocol, ownedCommand(acquireRequest, initial.state.bookRevision));
  expect(acquired.result.disposition).toBe("committed");
  const issueRequest = fixture([issue("free", 0n)]).request;
  const backwards = executeBookCommand(acquired.state, acquired.protocol, ownedCommand({ ...issueRequest, accountingDate: localDate("2026-01-13") }, acquired.state.bookRevision, "backdated-issue"));
  expect(backwards.result.disposition).toBe("rejected");
  expect(backwards.result.diagnostics[0]!.path).toBe("ownedInventory.issueSource");
  const closed = executeBookCommand(backwards.state, backwards.protocol, sealCommand({
    type: "closePeriod", id: commandId("owned-close"), bookId: IDS.book, expectedBookRevision: acquired.state.bookRevision,
    actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"), periodId: IDS.period1, closePackageId: closePackageId("owned-close-package"), reason: "Period reviewed",
    reportPopulationHash: hashCanonical({ population: "owned-test" }), reportingPolicySnapshotHash: hashCanonical({ reportingPolicy: "owned-test" }),
    issuedAt: instant("2026-01-31T23:00:00Z"), completedAt: instant("2026-01-31T23:00:01Z"), committedAt: instant("2026-01-31T23:00:02Z"),
  }));
  expect(closed.result.disposition, JSON.stringify(closed.result.diagnostics)).toBe("committed");
  expect(validateBookState(closed.state)).toEqual([]);
  const closedIssue = sealCommand({ ...ownedCommand(issueRequest, closed.state.bookRevision, "closed-period-issue"),
    issuedAt: instant("2026-02-01T00:00:00Z"), completedAt: instant("2026-02-01T00:00:01Z"), committedAt: instant("2026-02-01T00:00:02Z") });
  const denied = executeBookCommand(closed.state, closed.protocol, closedIssue);
  expect(denied.result.disposition).toBe("rejected");
  expect(denied.result.diagnostics[0]!.code).toBe("fiscal_period_admission");
  expect(denied.state.inventoryOwnershipEffects).toHaveLength(1);
  const reopened = executeBookCommand(denied.state, denied.protocol, sealCommand({
    type: "reopenPeriod", id: commandId("owned-reopen"), bookId: IDS.book, expectedBookRevision: denied.state.bookRevision,
    actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"), periodId: IDS.period1, reason: "Approved inventory correction",
    issuedAt: instant("2026-02-01T00:01:00Z"), completedAt: instant("2026-02-01T00:01:01Z"), committedAt: instant("2026-02-01T00:01:02Z"),
  }));
  expect(reopened.result.disposition).toBe("committed");
  const issued = executeBookCommand(reopened.state, reopened.protocol, sealCommand({ ...ownedCommand(issueRequest, reopened.state.bookRevision, "reopened-issue"),
    issuedAt: instant("2026-02-01T00:02:00Z"), completedAt: instant("2026-02-01T00:02:01Z"), committedAt: instant("2026-02-01T00:02:02Z") }));
  expect(issued.result.disposition, JSON.stringify(issued.result.diagnostics)).toBe("committed");
  expect(issued.state.lotHoldings[0]!.remainingQuantity.toString()).toBe("0/1");
  expect(issued.state.inventoryOwnershipEffects).toHaveLength(2);
  expect(issued.state.latestPostingSequence).toBe(0n);
  expect(validateBookState(issued.state)).toEqual([]);
  const encoded = encodeDurableBook({ state: issued.state, protocol: issued.protocol }), decoded = decodeDurableBook(encoded);
  expect(decoded.disposition, decoded.disposition === "rejected" ? decoded.message : "").toBe("decoded");
  if (decoded.disposition !== "decoded") throw new Error("Expected full owned history");
  const retried = executeBookCommand(decoded.aggregate.state, decoded.aggregate.protocol, closedIssue);
  expect(retried.result.disposition).toBe("replayed");
  expect(retried.result.resultHash).toEqual(denied.result.resultHash);
  expect(retried.result.diagnostics).toEqual(denied.result.diagnostics);
  expect(encodeDurableBook({ state: retried.state, protocol: retried.protocol })).toBe(encoded);
});

test("legacy disposal in another account cannot reuse an owned quantity-allocation identity", () => {
  const initial = activatedOwnedBook(true);
  const owned = executeBookCommand(initial.state, initial.protocol, ownedCommand(fixture([acquisition(), issue("free")]).request, 1n));
  expect(owned.result.disposition).toBe("committed");
  const other = accountId("unmanaged-inventory"), stock = entry("unmanaged", q(100n));
  const common = { bookId: IDS.book, actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"),
    issuedAt: instant("2026-01-16T13:00:00Z"), completedAt: instant("2026-01-16T13:00:01Z"), committedAt: instant("2026-01-16T13:00:02Z") };
  const acquireJournal = journal("unmanaged-acquire"), disposeJournal = journal("unmanaged-dispose");
  const acquired = executeBookCommand(owned.state, owned.protocol, sealCommand({ ...common, type: "postJournal", id: commandId("unmanaged-acquire"), expectedBookRevision: 2n,
    resolved: resolved({ ...acquireJournal, postings: [{ ...acquireJournal.postings[0]!, accountId: other,
      units: { canonicalNumber: q(1n), commodityId: IDS.usd }, costBasis: { totalBasis: q(100n), basisCommodityId: IDS.usd } }, acquireJournal.postings[1]!] }),
    lotOperations: [{ type: "acquire", lot: stock.lot, holding: { ...stock.holding, accountId: other }, journalPostingId: acquireJournal.postings[0]!.id }] }));
  expect(acquired.result.disposition, JSON.stringify(acquired.result.diagnostics)).toBe("committed");
  const dispose = (id: string, allocation: string) => sealCommand({ ...common, type: "postJournal" as const, id: commandId(id), expectedBookRevision: 3n,
    resolved: resolved({ ...disposeJournal, postings: [{ ...disposeJournal.postings[0]!, accountId: other,
      units: { canonicalNumber: q(-1n), commodityId: IDS.usd }, bookValue: { amount: D.parse("-100.00"), functionalCommodityId: IDS.usd },
      costBasis: { totalBasis: q(-100n), basisCommodityId: IDS.usd } }, { ...disposeJournal.postings[1]!,
      units: { canonicalNumber: q(100n), commodityId: IDS.usd }, bookValue: { amount: D.parse("100.00"), functionalCommodityId: IDS.usd } }] }),
    lotOperations: [{ type: "dispose" as const, holdingIds: [stock.holding.id], requestedQuantity: q(1n), selection: { method: "fifo" as const },
      derivation: accountingDerivation, identities: [{ holdingId: stock.holding.id, allocationId: lotAllocationId(allocation) }], journalPostingId: disposeJournal.postings[0]!.id }] });
  const denied = executeBookCommand(acquired.state, acquired.protocol, dispose("unmanaged-collision", "allocation-1"));
  expect(denied.result.disposition).toBe("rejected");
  expect(denied.result.diagnostics.map((d) => d.path)).toContain("command.inventoryOwnership.allocationIdentity");
  expect(denied.state).toBe(acquired.state);
  const valid = executeBookCommand(denied.state, denied.protocol, dispose("unmanaged-safe", "unmanaged-safe-allocation"));
  expect(valid.result.disposition).toBe("committed");
  expect(valid.state.lotAllocations.map((a) => a.allocation.id)).toEqual([lotAllocationId("unmanaged-safe-allocation")]);
  expect(valid.state.inventoryOwnershipEffects![0]!.quantityOnlyMovements.filter((m): m is QuantityOnlyInventoryReductionMovement => isInventoryPostedReductionMovement(m)).map((m) => m.quantityAllocation.id)).toEqual([lotAllocationId("allocation-1")]);
  expect(validateBookState(valid.state)).toEqual([]);
  expect(decodeDurableBook(encodeDurableBook({ state: valid.state, protocol: valid.protocol })).disposition).toBe("decoded");
});

test("ordered acquisition and transfer yield destination positions and anchors", () => {
  const f = fixture([acquisition(), transfer(lotHoldingId("holding-free"))]);
  const result = ready(f.context, f.request);
  expect(result.effect.newAnchors).toHaveLength(2);
  expect(result.effect.quantityOnlyMovements).toHaveLength(3);
  expect(result.afterHoldings.map((h) => h.id)).toContain(lotHoldingId("xfer-dest-holding-1"));
  expect(decodeInventoryOwnershipArtifact("ownershipEffect", encodeInventoryOwnershipArtifact("ownershipEffect", result.effect)).disposition).toBe("decoded");
  rejected(f.context, { ...f.request, algorithmVersion: semanticVersion("1.0.0") }, "ownedInventory.request");
});

for (const destination of [false, true]) {
  for (const quantization of [false, true]) {
    test(`owned ${destination ? "destination" : "source"} ${quantization ? "quantization" : "inventory"} policy admits its start and excludes its end`, () => {
      const windows = quantization
        ? ["2026-01-14", "2026-01-15", "2026-01-16"].map(localDate)
        : ["2026-01-15T11:59:59Z", "2026-01-15T12:00:00Z", "2026-01-15T12:00:01Z"].map(instant);
      for (const boundary of ["validFrom", "validTo"] as const) {
        for (const [index, value] of windows.entries()) {
          const applicable = boundary === "validFrom" ? index <= 1 : index > 1;
          const selectedQuantization = quantization
            ? { ...quantizationPolicy, id: quantizationPolicyId("boundary-quantization"), [boundary]: value }
            : quantizationPolicy;
          const selectedPolicy: InventoryCostPolicy = {
            ...inventoryPolicy,
            ...(destination ? { id: policyId("boundary-destination") } : {}),
            ...(quantization ? {} : { [boundary]: value }),
            quantizationPolicy: selectedQuantization,
          };
          const reference = { policyId: selectedPolicy.id, policyVersion: selectedPolicy.version,
            policyContentHash: hashAccountingPolicy(selectedPolicy) };
          const operations: OwnedInventoryOperationInput[] = destination
            ? [acquisition(), { ...transfer(lotHoldingId("holding-free")), destinationInventoryPolicy: reference }]
            : [{ ...acquisition(), inventoryPolicy: reference }];
          const f = fixture(operations);
          const context = {
            ...f.context,
            accountingPolicies: destination ? [inventoryPolicy, selectedPolicy] : [selectedPolicy],
            quantizationPolicies: destination && quantization
              ? [quantizationPolicy, selectedQuantization] : [selectedQuantization],
          };
          if (applicable) {
            const result = ready(context, f.request);
            expect(result.effect.journalLinkedMovements).toEqual([]);
            expect(result.afterHoldings.reduce((sum, holding) => sum.add(holding.remainingQuantity), q(0n)).toString()).toBe("1/1");
            expect(result.effect.newAnchors.every((anchor) => anchor.postedBudget.isZero())).toBe(true);
          } else {
            rejected(context, f.request, quantization ? "ownedInventory.quantization" : "ownedInventory.policy");
          }
        }
      }
    });
  }
}

test("transfer destinations require complete unowned-stock and opening-balance checks", () => {
  const initial = activatedOwnedBook(true), destination = accountId("unmanaged-inventory");
  const f = fixture([acquisition(), transfer(lotHoldingId("holding-free"), q(1n), 1n, destination)]);
  const command = ownedCommand(f.request, 1n);
  const context: BookOwnedInventoryReadContext = {
    ...initial.state, executionProfile: STRUCTURAL_SOURCE_IDENTITY_PROFILE,
    ownership: f.context.ownership, readPool: f.context.readPool,
    identityPresence: f.context.identityPresence, managedMoneyScope: f.context.managedMoneyScope,
    latestMovementDate: f.context.latestMovementDate,
    hasLiveUnownedStock: () => false, postedMoneyBalance: () => R.zero(),
    periodStatus: () => "open", journalIdentity: () => "absent", postingIdentity: () => "absent",
  };
  const unowned = prepareBookOwnedInventory({ ...context, hasLiveUnownedStock: (accounts) => {
    expect(accounts.has(destination)).toBe(true);
    return accounts.has(destination);
  } }, command);
  expect("journals" in unowned).toBe(false);
  if ("journals" in unowned) throw new Error("Unowned destination admitted");
  expect(unowned[0]?.path).toBe("command.request.operations");
  const nonzero = prepareBookOwnedInventory({ ...context, postedMoneyBalance: (scope) => scope.accountId === destination ? q(1n) : R.zero() }, command);
  expect("journals" in nonzero).toBe(false);
  if ("journals" in nonzero) throw new Error("Nonzero destination admitted");
  expect(nonzero[0]?.path).toBe("command.request.ownershipOpeningBalance");
  expect(initial.state.inventoryOwnershipEffects).toBeUndefined();
});

for (const version of ["1.1.0", "1.2.0"]) test(`quantity-only transfers ${version} persist across command boundaries without changing posting sequence`, () => {
  const initial = activatedOwnedBook(), acquire = ownedCommand(fixture().request, 1n, "transfer-source");
  const acquired = executeBookCommand(initial.state, initial.protocol, acquire);
  expect(acquired.result.disposition).toBe("committed");
  const request = { ...fixture([transfer(lotHoldingId("holding-free"), q(1n), 0n)]).request, algorithmVersion: semanticVersion(version) };
  const command = ownedCommand(request, 2n, "transfer-next");
  expect(() => assertBookCommandShape(command)).not.toThrow();
  const operation = request.operations[0]!;
  if (operation.kind !== "transfer") throw new Error("Expected transfer fixture");
  const { transferOutMovementId, ...identity } = operation.entries[0]!;
  const wrongShape = sealCommand({ ...command, request: { ...request, operations: [{ ...operation,
    entries: [{ ...identity, sourceMovementId: transferOutMovementId }],
  }] } } as never);
  expect(() => assertBookCommandShape(wrongShape)).toThrow();
  const moved = executeBookCommand(acquired.state, acquired.protocol, command);
  expect(moved.result.disposition, JSON.stringify(moved.result.diagnostics)).toBe("committed");
  expect(moved.state.bookRevision).toBe(3n);
  expect(moved.state.latestPostingSequence).toBe(0n);
  expect(moved.state.lotHoldings.map((holding) => [holding.id, holding.remainingQuantity.toString()])).toEqual([
    ["holding-free", "0/1"], ["xfer-dest-holding-0", "1/1"],
  ]);
  const bytes = encodeDurableBook({ state: moved.state, protocol: moved.protocol });
  const restored = decodeDurableBook(bytes);
  expect(restored.disposition, restored.disposition === "rejected" ? restored.message : "transfer restart").toBe("decoded");
  if (restored.disposition !== "decoded") throw new Error(restored.message);
  const retry = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, command);
  expect(retry.result.disposition).toBe("replayed");
  expect(encodeDurableBook({ state: retry.state, protocol: retry.protocol })).toBe(bytes);
  const badDate = executeBookCommand(acquired.state, acquired.protocol, ownedCommand({ ...request,
    governedAt: instant("2025-01-01T00:00:00Z"),
  }, 2n, "transfer-before-source"));
  expect(badDate.result.disposition).toBe("rejected");
  expect(badDate.result.diagnostics.map((d) => d.path)).toContain("ownedInventory.transferSource");
  expect(badDate.state).toBe(acquired.state);
});

test("transfer bounds, identity and policy validations fail closed", () => {
  const f = fixture([acquisition(), transfer(lotHoldingId("holding-free"))]);
  const badEntries = [{
    holdingId: lotHoldingId("holding-free"),
    allocationId: lotAllocationId("xfer-alloc-1"),
    transferOutMovementId: identifier<"InventoryPostedMovement">("xfer-out-1"),
    destinationAnchorId: identifier<"InventoryPostedAnchor">("xfer-dest-anchor-1"),
    destinationMovementId: identifier<"InventoryPostedMovement">("xfer-dest-mov-1"),
    destinationHoldingId: lotHoldingId("xfer-dest-holding-1"),
    destinationLotId: lotId("xfer-dest-lot-1"),
    evidence: new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1).fill(accountingDerivation.evidence[0]!),
  }];
  rejected(f.context, { ...f.request, operations: [acquisition(), { ...transfer(lotHoldingId("holding-free")), entries: badEntries }] }, "ownedInventory.bounds");

  // Transfer identity duplicate
  rejected(f.context, { ...f.request, operations: [acquisition(), transfer(lotHoldingId("holding-free"), q(1n), 1n, IDS.cash, { destinationMovementId: identifier("acquire-free") })] }, "ownedInventory.transferIdentity");

  // Unsorted destination dimensions
  const unsortedDims: OwnedInventoryOperationInput = {
    ...transfer(lotHoldingId("holding-free")),
    destinationCoordinate: { ...coordinate, dimensionMemberIds: [dimensionMemberId("z"), dimensionMemberId("a")] },
  };
  rejected(f.context, { ...f.request, operations: [acquisition(), unsortedDims] }, "ownedInventory.coordinate");

  // Mismatched destination booking policy
  const badBooking: OwnedInventoryOperationInput = {
    ...transfer(lotHoldingId("holding-free")),
    destinationCoordinate: { ...coordinate, bookingPolicy: { ...coordinate.bookingPolicy, policyId: policyId("wrong") } },
  };
  rejected(f.context, { ...f.request, operations: [acquisition(), badBooking] }, "ownedInventory.bookingPolicy");

  // Mismatched destination inventory policy
  const badInvPolicy: OwnedInventoryOperationInput = {
    ...transfer(lotHoldingId("holding-free")),
    destinationInventoryPolicy: { ...policyReference, policyId: policyId("wrong") },
  };
  rejected(f.context, { ...f.request, operations: [acquisition(), badInvPolicy] }, "ownedInventory.policy");

  const expiredDestination: InventoryCostPolicy = { ...inventoryPolicy, id: policyId("expired-destination"),
    quantizationPolicy: { ...quantizationPolicy, validTo: localDate("2026-01-01") } };
  const expiredReference = { policyId: expiredDestination.id, policyVersion: expiredDestination.version,
    policyContentHash: hashAccountingPolicy(expiredDestination) };
  rejected({ ...f.context, accountingPolicies: [inventoryPolicy, expiredDestination] },
    { ...f.request, operations: [acquisition(), { ...transfer(lotHoldingId("holding-free")), destinationInventoryPolicy: expiredReference }] },
    "ownedInventory.quantization");
  rejected(f.context, { ...f.request, operations: [acquisition(), { ...transfer(lotHoldingId("holding-free")),
    destinationPostingLink: { journalOrdinal: 0n, postingId: identifier<"Posting">("absent-posting"), referenceId: canonicalPostingReferenceId("absent-reference") } }] },
    "ownedInventory.postingLink");

  // Shortage on transfer without provisional treatment
  rejected(f.context, { ...f.request, operations: [acquisition(), transfer(lotHoldingId("holding-free"), q(10n))] }, "command.inventory.quantity");

  // Shortage on transfer with provisional policy triggers ownedInventory.shortage
  const provPolicy: InventoryCostPolicy = { ...inventoryPolicy, id: policyId("prov-policy"), shortageTreatment: "provisionalNegative",
    provisionalBasisMethod: "explicitRate", provisionalRate: q(1n),
    pools: [pool("inventory-prov", "cash")] };
  const provRef = { policyId: provPolicy.id, policyVersion: provPolicy.version, policyContentHash: hashAccountingPolicy(provPolicy) };
  const provDerivation = { ...accountingDerivation, policyId: provPolicy.id, policyVersion: provPolicy.version };
  const provContext: OwnedInventoryAccountingContext = { ...f.context, accountingPolicies: [...f.context.accountingPolicies, provPolicy] };
  const provTransfer: OwnedInventoryOperationInput = {
    ...transfer(lotHoldingId("holding-free"), q(10n)),
    inventoryPolicy: provRef,
    derivation: provDerivation,
    destinationInventoryPolicy: provRef,
  };
  rejected(provContext, { ...f.request, operations: [acquisition(), provTransfer] }, "ownedInventory.shortage");
});

test("adopt operation integrates unowned holdings and enforces boundaries", () => {
  const unownedHolding: LotHolding = {
    id: lotHoldingId("holding-adoptable"), lotId: lotId("lot-adoptable"), bookId: IDS.book, accountId: IDS.cash,
    commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: q(2n), remainingTotalBasis: q(20n),
    remainingValuationAllowance: q(0n), remainingCarryingAmount: q(20n),
  };
  const f = fixture([adopt(unownedHolding, 0n, q(20n))]);
  const contextWithHolding: OwnedInventoryAccountingContext = {
    ...f.context,
    ownership: { ...f.context.ownership, readCurrentHolding: (id) => id === unownedHolding.id ? unownedHolding : undefined },
  };
  const res = ready(contextWithHolding, f.request);
  expect(res.effect.newAnchors).toHaveLength(1);
  expect(res.effect.quantityOnlyMovements).toHaveLength(1);
  rejected({ ...contextWithHolding, ownership: { ...contextWithHolding.ownership, readCurrentHolding: () => ({ ...unownedHolding, remainingQuantity: q(0n) }) } },
    f.request, "ownedInventory.adoptionSource");

  // Bounds check on adopt
  const badEntries = [{
    anchorId: identifier<"InventoryPostedAnchor">("adopt-anchor-bad"),
    movementId: identifier<"InventoryPostedMovement">("adopt-mov-bad"),
    holdingId: unownedHolding.id,
    evidence: new Array(ACCOUNTING_LIMITS.maxInventoryLayers + 1).fill(accountingDerivation.evidence[0]!),
    historicalPostings: [],
  }];
  rejected(contextWithHolding, { ...f.request, operations: [{ ...adopt(unownedHolding, 0n), entries: badEntries }] }, "ownedInventory.bounds");

  // Non-existent holding
  rejected(f.context, f.request, "ownedInventory.adoptionSource");

  // Duplicate identity across operations (reuses anchor from acquisition)
  const dupAnchorAdopt = adopt(unownedHolding, 1n, q(20n));
  const badAdoptOp: OwnedInventoryOperationInput = {
    ...dupAnchorAdopt,
    entries: [{ ...dupAnchorAdopt.entries[0]!, anchorId: identifier("anchor-free") as never, movementId: identifier("adopt-mov-bad-id") }],
  };
  rejected(contextWithHolding, { ...f.request, operations: [acquisition(), badAdoptOp] }, "ownedInventory.adoptionIdentity");
});

test("executeBookCommand retains unverified legacy adoption as a rejection", () => {
  const initial = activatedOwnedBook();
  const stock = entry("unmanaged-cash", q(100n));
  const common = { bookId: IDS.book, actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"),
    issuedAt: instant("2026-01-16T13:00:00Z"), completedAt: instant("2026-01-16T13:00:01Z"), committedAt: instant("2026-01-16T13:00:02Z") };
  const acquireJournal = journal("unmanaged-acquire");
  const acquired = executeBookCommand(initial.state, initial.protocol, sealCommand({ ...common, type: "postJournal", id: commandId("unmanaged-acquire"), expectedBookRevision: 1n,
    resolved: resolved({ ...acquireJournal, postings: [{ ...acquireJournal.postings[0]!, accountId: IDS.cash,
      units: { canonicalNumber: q(1n), commodityId: IDS.usd }, costBasis: { totalBasis: q(100n), basisCommodityId: IDS.usd } }, acquireJournal.postings[1]!] }),
    lotOperations: [{ type: "acquire", lot: stock.lot, holding: stock.holding, journalPostingId: acquireJournal.postings[0]!.id }] }));
  expect(acquired.result.disposition).toBe("committed");

  // Adopt the unowned holding into managed inventory
  const adoptReq: OwnedInventoryTransactionRequest = {
    algorithm: "cumulativePostedInventoryV1", algorithmVersion: semanticVersion("1.0.0"),
    accountingDate: localDate("2026-01-16"), governedAt: instant("2026-01-16T14:00:00Z"), fiscalPeriodId: IDS.period1,
    operations: [adopt(stock.holding, 0n, q(100n))],
    resolvedJournals: [],
  };
  const adoptCmd = sealCommand({ ...ownedCommand(adoptReq, 2n, "adopt-command"),
    issuedAt: instant("2026-01-16T14:00:00Z"), completedAt: instant("2026-01-16T14:00:01Z"), committedAt: instant("2026-01-16T14:00:02Z") });
  const denied = executeBookCommand(acquired.state, acquired.protocol, adoptCmd);
  expect(denied.result.disposition).toBe("rejected");
  expect(denied.result.diagnostics.map((d) => d.path)).toEqual(["command.request.adoption"]);
  expect(denied.state).toBe(acquired.state);
  expect(denied.state.bookRevision).toBe(2n);
  expect(denied.state.latestPostingSequence).toBe(acquired.state.latestPostingSequence);
  expect(denied.state.inventoryOwnershipEffects).toBeUndefined();
  const restored = decodeDurableBook(encodeDurableBook({ state: denied.state, protocol: denied.protocol }));
  expect(restored.disposition, restored.disposition === "rejected" ? restored.message : "durable adoption rejection").toBe("decoded");
  const retry = executeBookCommand(denied.state, denied.protocol, adoptCmd);
  expect(retry.result.disposition).toBe("replayed");
  expect(retry.state).toBe(denied.state);
  expect(retry.result.diagnostics).toEqual(denied.result.diagnostics);
});

test("money-bearing transfer links source and destination journal postings", () => {
  const f = fixture([
    acquisition([entry("paid-source", q(100n))]),
  ]);
  const rawAcq = journal("paid-acq"), acqPost = { ...rawAcq.postings[0]!, units: { canonicalNumber: q(1n), commodityId: IDS.usd },
    bookValue: { amount: D.parse("100.00"), functionalCommodityId: IDS.usd }, costBasis: { totalBasis: q(100n), basisCommodityId: IDS.usd } };
  const acqResolved = resolved({ ...rawAcq, postings: [acqPost, { ...rawAcq.postings[1]!, bookValue: { amount: D.parse("-100.00"), functionalCommodityId: IDS.usd } }] });
  const acqOp: OwnedInventoryOperationInput = {
    ...acquisition([entry("paid-source", q(100n))]),
    postingLink: { journalOrdinal: 0n, postingId: acqPost.id, referenceId: canonicalPostingReferenceId("acq-ref") },
  };
  const rawXfer = journal("paid-xfer");
  const srcPost = { ...rawXfer.postings[0]!, units: { canonicalNumber: q(-1n), commodityId: IDS.usd },
    bookValue: { amount: D.parse("-100.00"), functionalCommodityId: IDS.usd }, costBasis: { totalBasis: q(-100n), basisCommodityId: IDS.usd } };
  const dstPost = { ...rawXfer.postings[1]!, accountId: IDS.cash, units: { canonicalNumber: q(1n), commodityId: IDS.usd },
    bookValue: { amount: D.parse("100.00"), functionalCommodityId: IDS.usd }, costBasis: { totalBasis: q(100n), basisCommodityId: IDS.usd } };
  const xferResolved = resolved({ ...rawXfer, postings: [srcPost, dstPost] });

  const xferOp: OwnedInventoryOperationInput = {
    ...transfer(lotHoldingId("holding-paid-source"), q(1n), 1n, IDS.cash),
    postingLink: { journalOrdinal: 1n, postingId: srcPost.id, referenceId: canonicalPostingReferenceId("xfer-src-ref") },
    destinationPostingLink: { journalOrdinal: 1n, postingId: dstPost.id, referenceId: canonicalPostingReferenceId("xfer-dst-ref") },
  };

  const book = activatedOwnedBook();
  const cmd = ownedCommand({
    ...f.request,
    algorithmVersion: semanticVersion("1.1.0"),
    operations: [acqOp, xferOp],
    resolvedJournals: [acqResolved, xferResolved],
  }, 1n);
  const res = executeBookCommand(book.state, book.protocol, cmd);
  expect(res.result.disposition, JSON.stringify(res.result.diagnostics)).toBe("committed");
  expect(res.state.inventoryOwnershipEffects![0]!.journalLinkedMovements).toHaveLength(3);
  expect(validateBookState(res.state)).toEqual([]);
  const stored = encodeDurableBook({ state: res.state, protocol: res.protocol });
  const restored = decodeDurableBook(stored);
  expect(restored.disposition, restored.disposition === "rejected" ? restored.message : "transfer round trip").toBe("decoded");
  if (restored.disposition !== "decoded") throw new Error(restored.message);
  expect(encodeDurableBook(restored.aggregate)).toBe(stored);
  // The destination may use journal zero in a subsequent command; zero is a
  // valid ordinal, not a missing link or a reason to reject positive stock.
  const later = ownedCommand({ ...f.request, algorithmVersion: semanticVersion("1.1.0"),
    operations: [{ ...xferOp, ordinal: 0n, postingLink: { ...xferOp.postingLink!, journalOrdinal: 0n },
      destinationPostingLink: { ...xferOp.destinationPostingLink!, journalOrdinal: 0n } }], resolvedJournals: [xferResolved] }, 2n, "transfer-only");
  const acquiredOnly = executeBookCommand(book.state, book.protocol, ownedCommand({ ...f.request, operations: [acqOp], resolvedJournals: [acqResolved] }, 1n));
  expect(acquiredOnly.result.disposition).toBe("committed");
  const moved = executeBookCommand(acquiredOnly.state, acquiredOnly.protocol, later);
  expect(moved.result.disposition, JSON.stringify(moved.result.diagnostics)).toBe("committed");
  expect(moved.state.inventoryOwnershipEffects![1]!.journalLinkedMovements.map((m) => m.postedAmount.toString())).toEqual(["-100.00", "100.00"]);
});

test("owned inventory transaction on exact firstAccountingDate boundary commits", () => {
  const book = activatedOwnedBook();
  const firstDate = book.state.openingBoundary!.firstAccountingDate;
  expect(firstDate).toBe(localDate("2026-01-01"));
  const f = fixture([acquisition()]);
  const cmd = ownedCommand({
    ...f.request,
    accountingDate: firstDate,
  }, 1n, "first-date-acq");
  const res = executeBookCommand(book.state, book.protocol, cmd);
  expect(res.result.disposition).toBe("committed");
});

test("validateBookEffectTopology catches correctJournal targeting inventory source journal", () => {
  const f = fixture([acquisition([entry("paid-source", q(100n))])]);
  const rawAcq = journal("paid-acq-correct");
  const acqPost = { ...rawAcq.postings[0]!, units: { canonicalNumber: q(1n), commodityId: IDS.usd },
    bookValue: { amount: D.parse("100.00"), functionalCommodityId: IDS.usd }, costBasis: { totalBasis: q(100n), basisCommodityId: IDS.usd } };
  const acqResolved = resolved({ ...rawAcq, postings: [acqPost, { ...rawAcq.postings[1]!, bookValue: { amount: D.parse("-100.00"), functionalCommodityId: IDS.usd } }] });
  const acqOp: OwnedInventoryOperationInput = {
    ...acquisition([entry("paid-source", q(100n))]),
    postingLink: { journalOrdinal: 0n, postingId: acqPost.id, referenceId: canonicalPostingReferenceId("acq-ref-correct") },
  };
  const book = activatedOwnedBook();
  const cmd = ownedCommand({
    ...f.request,
    algorithmVersion: semanticVersion("1.0.0"),
    operations: [acqOp],
    resolvedJournals: [acqResolved],
  }, 1n, "acq-for-correction");
  const res = executeBookCommand(book.state, book.protocol, cmd);
  expect(res.result.disposition).toBe("committed");

  const correctionCommand = sealCommand({
    id: commandId("dummy-correct"),
    type: "correctJournal" as const,
    bookId: IDS.book,
    protocolVersion: semanticVersion("1.0.0"),
    expectedBookRevision: res.state.bookRevision,
    actorId: IDS.actor,
    issuedAt: instant("2026-01-16T14:00:00Z"),
    completedAt: instant("2026-01-16T14:00:01Z"),
    committedAt: instant("2026-01-16T14:00:02Z"),
    correctionKind: "reversal" as const,
    originalJournalId: rawAcq.id,
    resolved: resolved(journal("unrelated-journal")),
  });
  const intent: BookCommitIntent = {
    command: correctionCommand,
    expectedBookRevision: res.state.bookRevision,
    nextBookRevision: res.state.bookRevision + 1n,
    resultingPostingSequence: res.state.latestPostingSequence,
    expectedConfigurationRevision: res.state.configurationRevision,
    nextConfigurationRevision: res.state.configurationRevision,
    resultingConfigurationHash: res.state.configurationHash,
    effects: [],
    canonicalHash: hashCanonical({ dummy: true }),
  };
  const diags = validateBookEffectTopology(res.state, intent);
  expect(diags.some((d) => d.code === "inventory_cost_policy_incoherent" && d.path === "command.inventoryOwnership")).toBeTrue();
});

test("owned inventory transaction rejects reuse of posting reference from accountingState", () => {
  const book = activatedOwnedBook();
  const rawAcq = journal("paid-acq-ref-reuse");
  const acqPost = { ...rawAcq.postings[0]!, units: { canonicalNumber: q(1n), commodityId: IDS.usd },
    bookValue: { amount: D.parse("100.00"), functionalCommodityId: IDS.usd }, costBasis: { totalBasis: q(100n), basisCommodityId: IDS.usd } };
  const acqResolved = resolved({ ...rawAcq, postings: [acqPost, { ...rawAcq.postings[1]!, bookValue: { amount: D.parse("-100.00"), functionalCommodityId: IDS.usd } }] });

  const existingRef = postingReference(rawAcq, "prior:journal:0");
  const openItemBody = {
    id: identifier<"OpenItem">("planted-open-item"),
    bookId: IDS.book,
    kind: "receivable" as const,
    scope: { externalPartyId: "CUSTOMER", controlAccountId: IDS.cash },
    recognitionSource: existingRef,
    recognizedOn: localDate("2026-01-15"),
    denominationCommodityId: IDS.usd,
    denomination: q(100n),
    bookValue: q(100n),
    derivation: accountingDerivation,
  };
  const rawStateWithOpenItem: BookState = {
    ...book.state,
    accountingState: {
      ...book.state.accountingState,
      openItems: [{
        ...openItemBody,
        contentHash: hashCanonical({ type: "OpenItem", value: canonicalAccountingValue(openItemBody) }),
      }],
    },
  };
  const stateWithOpenItem: BookState = {
    ...rawStateWithOpenItem,
    contentHash: hashBookState(rawStateWithOpenItem),
  };

  const f = fixture([acquisition([entry("paid-source", q(100n))])]);
  const acqOp: OwnedInventoryOperationInput = {
    ...acquisition([entry("paid-source", q(100n))]),
    postingLink: { journalOrdinal: 0n, postingId: acqPost.id, referenceId: existingRef.id },
  };
  const cmd = ownedCommand({
    ...f.request,
    algorithmVersion: semanticVersion("1.0.0"),
    operations: [acqOp],
    resolvedJournals: [acqResolved],
  }, 1n, "acq-reused-ref");

  const evaluated = evaluateBookCommand(stateWithOpenItem, book.protocol, cmd);
  expect(evaluated.disposition).toBe("finished");
  if (evaluated.disposition !== "finished") throw new Error("Expected finished evaluation");
  expect(evaluated.result.disposition).toBe("rejected");
  expect(evaluated.result.diagnostics.some((d: { path: string }) => d.path === "ownedInventory.postingLink")).toBeTrue();
});

test("ownedMovements chronological sort order across revisions preserves current position", () => {
  let book = activatedOwnedBook();
  const lotStock: InventoryPostedAcquisitionEntry = {
    lot: { id: lotId("multi-lot"), bookId: IDS.book, commodityId: IDS.usd, basisCommodityId: IDS.usd,
      acquiredAt: instant("2026-01-15T12:00:00Z"), acquisitionQuantity: q(2n), acquisitionTotalBasis: q(0n),
      evidenceIds: accountingDerivation.evidence.map((e) => e.id) },
    holding: { id: lotHoldingId("multi-holding"), lotId: lotId("multi-lot"), bookId: IDS.book, accountId: IDS.cash,
      commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: q(2n), remainingTotalBasis: q(0n),
      remainingValuationAllowance: q(0n), remainingCarryingAmount: q(0n) },
    anchorId: identifier<"InventoryPostedAnchor">("multi-anchor"),
    movementId: identifier<"InventoryPostedMovement">("multi-acquire-mov"),
    evidence: accountingDerivation.evidence,
  };
  const acqOp: OwnedInventoryOperationInput = {
    kind: "acquisition", ordinal: 0n, id: identifier<"InventoryOperation">("multi-acq-op"), coordinate, inventoryPolicy: policyReference,
    derivation: accountingDerivation, entries: [lotStock],
  };
  const acqCmd = ownedCommand({
    algorithm: "cumulativePostedInventoryV1", algorithmVersion: semanticVersion("1.0.0"),
    accountingDate: localDate("2026-01-15"), governedAt: instant("2026-01-15T12:00:00Z"), fiscalPeriodId: IDS.period1,
    operations: [acqOp], resolvedJournals: [],
  }, 1n, "rev2-acq");
  book = executeBookCommand(book.state, book.protocol, acqCmd);
  expect(book.result.disposition).toBe("committed");

  const issue1Op: OwnedInventoryOperationInput = {
    kind: "issue", ordinal: 0n, id: identifier<"InventoryOperation">("multi-issue-1-op"), coordinate, inventoryPolicy: policyReference,
    derivation: accountingDerivation, quantity: q(1n),
    identities: [{ holdingId: lotHoldingId("multi-holding"), allocationId: lotAllocationId("multi-issue-alloc-1"), movementId: identifier<"InventoryPostedMovement">("multi-issue-mov-1") }],
  };
  const issue1Cmd = ownedCommand({
    algorithm: "cumulativePostedInventoryV1", algorithmVersion: semanticVersion("1.0.0"),
    accountingDate: localDate("2026-01-15"), governedAt: instant("2026-01-15T13:00:00Z"), fiscalPeriodId: IDS.period1,
    operations: [issue1Op], resolvedJournals: [],
  }, 2n, "rev3-issue1");
  book = executeBookCommand(book.state, book.protocol, issue1Cmd);
  expect(book.result.disposition).toBe("committed");

  const issue2Op: OwnedInventoryOperationInput = {
    kind: "issue", ordinal: 0n, id: identifier<"InventoryOperation">("multi-issue-2-op"), coordinate, inventoryPolicy: policyReference,
    derivation: accountingDerivation, quantity: q(1n),
    identities: [{ holdingId: lotHoldingId("multi-holding"), allocationId: lotAllocationId("multi-issue-alloc-2"), movementId: identifier<"InventoryPostedMovement">("multi-issue-mov-2") }],
  };
  const issue2Cmd = ownedCommand({
    algorithm: "cumulativePostedInventoryV1", algorithmVersion: semanticVersion("1.0.0"),
    accountingDate: localDate("2026-01-15"), governedAt: instant("2026-01-15T14:00:00Z"), fiscalPeriodId: IDS.period1,
    operations: [issue2Op], resolvedJournals: [],
  }, 3n, "rev4-issue2");
  const res4 = executeBookCommand(book.state, book.protocol, issue2Cmd);
  expect(res4.result.disposition).toBe("committed");
});

test("algorithmVersion 1.2.0 excludes depleted holdings with missing lot from pool", () => {
  let book = activatedOwnedBook();
  const acqOp = acquisition([entry("v120-pool", q(0n))]);
  const acqCmd = ownedCommand({
    algorithm: "cumulativePostedInventoryV1", algorithmVersion: semanticVersion("1.0.0"),
    accountingDate: localDate("2026-01-15"), governedAt: instant("2026-01-15T12:00:00Z"), fiscalPeriodId: IDS.period1,
    operations: [acqOp], resolvedJournals: [],
  }, 1n, "v120-acq");
  book = executeBookCommand(book.state, book.protocol, acqCmd);
  expect(book.result.disposition).toBe("committed");

  const depletedHolding: LotHolding = {
    id: lotHoldingId("depleted-holding-no-lot"),
    lotId: lotId("missing-lot-depleted"),
    bookId: IDS.book,
    accountId: IDS.cash,
    commodityId: IDS.usd,
    basisCommodityId: IDS.usd,
    remainingQuantity: q(0n),
    remainingTotalBasis: q(0n),
    remainingValuationAllowance: q(0n),
    remainingCarryingAmount: q(0n),
  };
  const rawStateWithDepleted: BookState = {
    ...book.state,
    lotHoldings: [...book.state.lotHoldings, depletedHolding],
  };
  const stateWithDepleted: BookState = {
    ...rawStateWithDepleted,
    contentHash: hashBookState(rawStateWithDepleted),
  };

  const issueOp = issue("v120-pool", 0n);
  const issueCmd = ownedCommand({
    algorithm: "cumulativePostedInventoryV1", algorithmVersion: semanticVersion("1.2.0"),
    accountingDate: localDate("2026-01-15"), governedAt: instant("2026-01-15T13:00:00Z"), fiscalPeriodId: IDS.period1,
    operations: [issueOp], resolvedJournals: [],
  }, 2n, "v120-issue");

  const evaluated = evaluateBookCommand(stateWithDepleted, book.protocol, issueCmd);
  expect(evaluated.disposition).toBe("ready");
});

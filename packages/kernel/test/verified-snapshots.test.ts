import { describe, expect, test } from "bun:test";
import * as kernel from "../src/index.ts";
import {
  ExactDecimal,
  ExactRational,
  CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  accountId,
  commandId,
  createBookState,
  decodeDurableBook,
  dimensionId,
  dimensionMemberId,
  encodeDurableBook,
  evaluateBookCommandAdmission,
  executeBookCommand,
  instant,
  localDate,
  policyId,
  sealCommand,
  semanticVersion,
  validateBookState,
  type AccountingPolicy,
  type AccountingBasisPolicy,
  type AllocationPolicy,
  type BookConfigurationSnapshot,
  type BookState,
  type ConsolidationPolicy,
  type CurrencyPolicy,
  type InventoryCostPolicy,
  type InventoryValueAdjustmentPolicy,
  type MonetaryClassificationPolicy,
  type TaxPolicy,
} from "../src/index.ts";
import { markVerifiedSnapshot, snapshotVerifications, verifiedOr } from "../src/verified-snapshots.ts";
import {
  basisRule,
  capability,
  classificationRule,
  consolidationMapping,
  consolidationValuationPolicy,
  pool,
  taxComponent,
  translationRule,
} from "./accounting-fixtures.ts";
import { IDS, identity, journal, periods, policy, quantizationPolicy, resolved } from "./fixtures.ts";
import { activationCommand, } from "./protocol-fixtures.ts";

// A snapshot's verification is reused only for an object that cannot change. These tests walk every
// object and array reachable from each snapshot at each place the kernel vouches for one, starting
// from deliberately mutable inputs, so the claim is checked and not assumed.

const acct = (value: string) => accountId(`account-${value}`);
const A = Object.freeze({
  inventory: acct("inventory"), cost: acct("cost"), adjustment: acct("adjustment"), ar: acct("ar"), gain: acct("gain"),
  loss: acct("loss"), allocation: acct("allocation"), contra: acct("contra"), inputTax: acct("input-tax"), ap: acct("ap"),
  elimination: acct("elimination"), target: acct("target"), translation: acct("translation"), nci: acct("nci"), equity: acct("equity"),
});
const one = ExactRational.of(1n, 1n);
const core = (kind: AccountingPolicy["kind"], id: string, method: string) => ({
  id: policyId(id), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"),
  algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability(kind, method),
});
const inventoryPolicy: InventoryCostPolicy = { ...core("inventoryCost", "imm-inventory", "fifo"), kind: "inventoryCost", method: "fifo",
  pools: [pool("imm-inventory-pool", "inventory")], shortageTreatment: "provisionalNegative", provisionalBasisMethod: "explicitRate", provisionalRate: ExactRational.of(7n, 1n) };
const inventoryValuePolicy: InventoryValueAdjustmentPolicy = { ...core("inventoryValueAdjustment", "imm-inventory-value", "valueAdjustment"),
  kind: "inventoryValueAdjustment", inventoryCostPolicyId: inventoryPolicy.id, inventoryCostPolicyVersion: inventoryPolicy.version,
  allowedKinds: ["directlyAttributableCost", "purchaseRebate", "productionOverhead", "writeDown", "writeDownReversal"],
  inventoryAccountId: A.inventory, recognizedCostAccountId: A.cost, adjustmentAccountId: A.adjustment };
const currencyPolicy: CurrencyPolicy = { ...core("currencyRemeasurement", "imm-currency", "closingRate"), kind: "currencyRemeasurement",
  reversalRequired: true, gainAccountId: A.gain, lossAccountId: A.loss };
const monetaryPolicy: MonetaryClassificationPolicy = { ...core("monetaryClassification", "imm-monetary", "accountRule"), kind: "monetaryClassification",
  rules: [classificationRule("imm-monetary-ar", "ar", "monetary")] };
const basisPolicy: AccountingBasisPolicy = { ...core("accountingBasis", "imm-basis", "cash"), kind: "accountingBasis", basis: "cash",
  rules: [basisRule("imm-basis-recognition", "recognition", "carryThrough"), basisRule("imm-basis-settlement", "settlement", "carryThrough"),
    basisRule("imm-basis-credit", "creditApplication", "carryThrough"), basisRule("imm-basis-writeoff", "writeOff", "carryThrough"),
    basisRule("imm-basis-tax", "tax", "carryThrough"), basisRule("imm-basis-inventory", "inventoryCost", "carryThrough"),
    basisRule("imm-basis-noncash", "nonCash", "exclude"), basisRule("imm-basis-rounding", "rounding", "carryThrough")] };
const allocationPolicy: AllocationPolicy = { ...core("allocationSchedule", "imm-allocation", "straightLine"), kind: "allocationSchedule", method: "straightLine",
  frequency: "monthly", convention: "fullPeriod", allocationAccountId: A.allocation, contraAccountId: A.contra };
const taxPolicy: TaxPolicy = { ...core("taxDetermination", "imm-tax", "compound"), kind: "taxDetermination", taxCode: "GST", jurisdiction: "TEST",
  roundingLevel: "lineLevel", components: [taxComponent("imm-tax-component", { rate: ExactRational.of(1n, 10n), inclusion: "exclusive",
    treatment: "inputTax", recoverability: "recoverable", recoverableShare: one, compoundOrdinal: 1n, compoundsOn: [], liabilityAccountId: A.ap, recoverableAccountId: A.inputTax })] };
const consolidationPolicy: ConsolidationPolicy = { ...core("consolidation", "imm-consolidation", "full"), kind: "consolidation", supportedMethods: ["full"],
  accountMappings: [consolidationMapping("imm-map-target", "target", "target"), consolidationMapping("imm-map-inventory", "inventory", "inventory", "source-book"),
    consolidationMapping("imm-map-equity", "equity", "equity", "source-book")],
  translationRules: [translationRule("imm-translate-target", "target", "target", "source-book"), translationRule("imm-translate-inventory", "inventory", "inventory", "source-book")],
  valuationPolicy: consolidationValuationPolicy("imm-valuation"), translationAdjustmentAccountId: A.translation,
  parentAttributableEquityAccountId: A.equity, nonControllingInterestAccountId: A.nci };
const everyKind: readonly AccountingPolicy[] = [inventoryPolicy, inventoryValuePolicy, basisPolicy, monetaryPolicy, currencyPolicy, allocationPolicy, taxPolicy, consolidationPolicy];

const axis = dimensionId("immutability-axis");
const member = dimensionMemberId("immutability-member");
const richAdmission = () => ({
  bookId: IDS.book, functionalCommodityId: IDS.usd,
  accounts: [IDS.cash, IDS.revenue, ...Object.values(A)].map((id, index) => ({
    id, bookId: IDS.book, code: `${1000 + index}`, name: id, role: index === 1 ? ("income" as const) : ("asset" as const),
    normalSide: index === 1 ? ("credit" as const) : ("debit" as const), postingAllowed: true, openedOn: localDate("2020-01-01"),
    allowedCommodityIds: [IDS.usd], ...(index > 2 ? { parentId: IDS.cash } : {}),
  })),
  dimensions: [{ id: axis, bookId: IDS.book, code: "DEPT", name: "Department", openedOn: localDate("2020-01-01") }],
  dimensionMembers: [{ id: member, dimensionId: axis, code: "SALES", name: "Sales", openedOn: localDate("2020-01-01") }],
  requiredDimensionIds: [] as never[],
  requiredDimensionIdsByPosting: { "reserved-generated-posting": [] as never[] },
});

/** A deep copy that nothing freezes: the caller's own mutable data, as an adapter would pass it. */
function thaw<T>(value: T): T {
  if (value === null || typeof value !== "object" || value instanceof ExactRational || value instanceof ExactDecimal) return value;
  if (Array.isArray(value)) return value.map(thaw) as T;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, thaw(entry)])) as T;
}

/** The path of every object or array reachable from `root` that can still be changed. */
function changeable(root: unknown, label: string): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string) => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (!Object.isFrozen(value)) found.push(path);
    for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
  };
  walk(root, label);
  return found;
}

function richGenesis(commitment: boolean): BookState {
  return createBookState(thaw(identity), thaw(periods), thaw(richAdmission()), thaw([policy]), thaw([quantizationPolicy]), thaw(everyKind),
    instant("2020-01-01T00:00:00Z"), undefined, commitment ? CHAIN_HEAD_STATE_COMMITMENT_PROFILE : undefined);
}

function richConfiguration(state: BookState, id: string) {
  const activation = activationCommand();
  return sealCommand({ id: commandId(id), type: "replaceConfiguration" as const, protocolVersion: activation.protocolVersion, bookId: IDS.book,
    actorId: IDS.actor, expectedBookRevision: state.bookRevision, expectedConfigurationRevision: state.configurationRevision,
    issuedAt: instant("2026-01-02T00:00:00Z"), completedAt: instant("2026-01-02T00:00:01Z"), committedAt: instant("2026-01-02T00:00:02Z"),
    effectiveOn: localDate("2026-01-02"), periods: thaw(periods), admissionSnapshot: thaw(richAdmission()), policies: thaw([policy]),
    quantizationPolicies: thaw([quantizationPolicy]), accountingPolicies: thaw(everyKind) });
}

const snapshotsOf = (state: BookState): BookConfigurationSnapshot[] => [state.activeConfigurationSnapshot, ...state.configurationSnapshots];

describe("a snapshot the kernel vouches for cannot change", () => {
  test("the fixture really starts from mutable input and holds every kind of accounting policy", () => {
    expect(changeable(thaw(everyKind), "policies").length).toBeGreaterThan(50);
    expect(changeable(thaw(richAdmission()), "admission").length).toBeGreaterThan(20);
    const state = richGenesis(true);
    expect(state.accountingPolicySnapshot.policies.map((item) => item.kind).sort()).toEqual(everyKind.map((item) => item.kind).sort());
  });

  for (const commitment of [true, false]) {
    test(`createBookState (commitment ${commitment}) freezes every part of the snapshot it vouches for`, () => {
      const started = snapshotVerifications();
      const state = richGenesis(commitment);
      // Marking had nothing left to freeze: construction already froze every part of the snapshot.
      expect(snapshotVerifications().froze - started.froze).toBe(0);
      for (const snapshot of snapshotsOf(state)) expect(changeable(snapshot, "snapshot")).toEqual([]);
      const before = snapshotVerifications();
      const outcome = evaluateBookCommandAdmission(state, { retainedResults: [] }, activationCommand());
      expect(outcome.disposition).toBe("continue");
      expect(snapshotVerifications().reused - before.reused).toBe(2);
    });

    test(`applyEffects (commitment ${commitment}) freezes every part of a committed configuration`, () => {
      const initial = richGenesis(commitment);
      const active = executeBookCommand(initial, { retainedResults: [] }, activationCommand());
      expect(active.result.disposition).toBe("committed");
      const started = snapshotVerifications();
      const changed = executeBookCommand(active.state, active.protocol, richConfiguration(active.state, "immutable-config"));
      expect(changed.result.disposition, JSON.stringify(changed.result.diagnostics)).toBe("committed");
      expect(snapshotVerifications().froze - started.froze).toBe(0);
      expect(changed.state.configurationSnapshots).toHaveLength(2);
      for (const snapshot of snapshotsOf(changed.state)) expect(changeable(snapshot, "snapshot")).toEqual([]);
      expect(validateBookState(changed.state)).toEqual([]);
    });

    test(`decodeDurableBook (commitment ${commitment}) freezes every part of every snapshot it vouches for`, () => {
      const initial = richGenesis(commitment);
      const active = executeBookCommand(initial, { retainedResults: [] }, activationCommand());
      const changed = executeBookCommand(active.state, active.protocol, richConfiguration(active.state, "decoded-config"));
      const started = snapshotVerifications();
      const decoded = decodeDurableBook(encodeDurableBook({ state: changed.state, protocol: changed.protocol }));
      if (decoded.disposition !== "decoded") throw new Error(decoded.message);
      expect(snapshotVerifications().froze - started.froze).toBe(0);
      for (const snapshot of snapshotsOf(decoded.aggregate.state)) expect(changeable(snapshot, "snapshot")).toEqual([]);
      const before = snapshotVerifications();
      expect(evaluateBookCommandAdmission(decoded.aggregate.state, decoded.aggregate.protocol, sealCommand({
        id: commandId("decoded-probe"), type: "postJournal", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
        expectedBookRevision: decoded.aggregate.state.bookRevision, issuedAt: instant("2026-02-22T14:00:00Z"),
        completedAt: instant("2026-02-22T14:00:01Z"), committedAt: instant("2026-02-22T14:00:02Z"), actorId: IDS.actor,
        resolved: resolved(journal("decoded-probe-journal", "2026-02-22")),
      })).disposition).toBe("continue");
      expect(snapshotVerifications().reused - before.reused).toBe(decoded.aggregate.state.configurationSnapshots.length + 1);
      expect(snapshotVerifications().rehashed).toBe(before.rehashed);
    });
  }

  test("marking freezes a snapshot's whole graph, whatever is shared or cyclic, and is idempotent", () => {
    const shared = { entries: [{ id: 1 }, { id: 2 }] };
    const cyclic: Record<string, unknown> = { shared, again: shared, list: [shared] };
    cyclic.self = cyclic;
    const loose = changeable(cyclic, "cyclic").length;
    expect(loose).toBeGreaterThan(3);
    const before = snapshotVerifications();
    markVerifiedSnapshot(cyclic);
    expect(snapshotVerifications().froze - before.froze).toBe(loose);
    expect(changeable(cyclic, "cyclic")).toEqual([]);
    expect(Object.isFrozen(shared.entries[1])).toBeTrue();
    markVerifiedSnapshot(cyclic);
    expect(snapshotVerifications().froze - before.froze).toBe(loose);
    expect(verifiedOr(cyclic, () => false)).toBeTrue();
    // A different object with the same content is not vouched for.
    const copy = { ...cyclic };
    expect(verifiedOr(copy, () => false)).toBeFalse();
    expect(verifiedOr(copy, () => true)).toBeTrue();
    // Numbers, strings and null reachable from a snapshot are simply left alone.
    markVerifiedSnapshot({ name: "x", count: 3, none: null, big: 9n, list: [] });
  });

  test("only admission reuses a verification: restoring and decoding recompute every hash", () => {
    const state = richGenesis(true);
    const before = snapshotVerifications();
    expect(validateBookState(state)).toEqual([]);
    const decoded = decodeDurableBook(encodeDurableBook({ state, protocol: { retainedResults: [] } }));
    expect(decoded.disposition).toBe("decoded");
    expect(snapshotVerifications()).toEqual(before);
  });

  test("no export of the package lets a caller vouch for a snapshot", () => {
    const hidden = [markVerifiedSnapshot, verifiedOr, snapshotVerifications] as unknown[];
    expect(Object.keys(kernel).filter((name) => /verified|snapshotVerifications/i.test(name))).toEqual([]);
    expect(Object.values(kernel).filter((value) => hidden.includes(value))).toEqual([]);
  });
});

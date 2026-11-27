import { describe, expect, test } from "bun:test";
import {
  accountingCapabilityAdmits,
  accountingPolicyCombination,
  allocationRecognitionId,
  allocationScheduleId,
  allocationScheduleRevisionId,
  bookHistoryMaterializations,
  canonicalPostingReferenceId,
  consolidationCompilationId,
  createAccountingPolicySnapshot,
  createBookProtocolState,
  executeBookCommand,
  hashAccountingPolicyArtifact,
  inventoryRecostingId,
  inventoryValueAdjustmentId,
  latestRetainedCommandResult,
  latestRevisionRecord,
  openItemId,
  provisionalInventoryLayerId,
  remeasurementResultId,
  remeasurementReversalId,
  settlementAllocationId,
  settlementId,
  taxDeterminationId,
  validateCanonicalPostingReferenceHash,
  verifyAccountingPolicyArtifacts,
  type AccountingCapability,
  type AccountingPolicy,
  type TaxPolicy,
} from "../src/index.ts";
import { hashCanonical, instant, policyId, semanticVersion } from "../src/index.ts";
import { IDS, freshState, journal, postingReference, quantizationPolicy } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";
import { account, capability, taxComponent } from "./accounting-fixtures.ts";

describe("accounting API surface completeness", () => {
  test("exposes typed identifier builders for every accounting effect family", () => {
    expect(provisionalInventoryLayerId("p").length).toBeGreaterThan(0);
    expect(inventoryRecostingId("r").length).toBeGreaterThan(0);
    expect(inventoryValueAdjustmentId("iv").length).toBeGreaterThan(0);
    expect(openItemId("o").length).toBeGreaterThan(0);
    expect(settlementId("s").length).toBeGreaterThan(0);
    expect(settlementAllocationId("sa").length).toBeGreaterThan(0);
    expect(remeasurementResultId("rr").length).toBeGreaterThan(0);
    expect(remeasurementReversalId("rx").length).toBeGreaterThan(0);
    expect(allocationScheduleId("as").length).toBeGreaterThan(0);
    expect(allocationRecognitionId("ar").length).toBeGreaterThan(0);
    expect(allocationScheduleRevisionId("asr").length).toBeGreaterThan(0);
    expect(canonicalPostingReferenceId("source").length).toBeGreaterThan(0);
    expect(taxDeterminationId("td").length).toBeGreaterThan(0);
    expect(consolidationCompilationId("cc").length).toBeGreaterThan(0);
  });

  test("admits capability combinations across every declared axis", () => {
    const allocationCapability: AccountingCapability = {
      feature: "allocationSchedule",
      status: "supported",
      implementationVersion: semanticVersion("1.0.0"),
      verificationEvidenceIds: Object.freeze([]),
      admittedCombinations: Object.freeze([
        { method: "straightLine", frequency: "monthly", convention: "fullPeriod" },
        { method: "unitsOfProduction", frequency: "eventDriven", convention: "usageEvent" },
      ]),
    };
    expect(accountingCapabilityAdmits(allocationCapability, { method: "straightLine", frequency: "monthly", convention: "fullPeriod" })).toBeTrue();
    expect(accountingCapabilityAdmits(allocationCapability, { method: "unitsOfProduction", frequency: "eventDriven", convention: "usageEvent" })).toBeTrue();
    expect(accountingCapabilityAdmits(allocationCapability, { method: "straightLine", frequency: "annual", convention: "fullPeriod" })).toBeFalse();
    expect(accountingCapabilityAdmits(allocationCapability, {})).toBeTrue();
    expect(accountingCapabilityAdmits({ ...allocationCapability, admittedCombinations: Object.freeze([]) }, {})).toBeFalse();
    const wildcardEntryCapability: AccountingCapability = {
      feature: "allocationSchedule",
      status: "supported",
      implementationVersion: semanticVersion("1.0.0"),
      verificationEvidenceIds: Object.freeze([]),
      admittedCombinations: Object.freeze([{}]),
    };
    expect(accountingCapabilityAdmits(wildcardEntryCapability, { method: "straightLine", frequency: "monthly", convention: "fullPeriod" })).toBeTrue();
    expect(accountingCapabilityAdmits(wildcardEntryCapability, { method: "decliningBalance" })).toBeTrue();

    const inventoryPolicy = Object.freeze({
      id: policyId("surface-inventory"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"),
      algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("inventoryCost", "fifo"),
      kind: "inventoryCost" as const, method: "fifo" as const, pools: Object.freeze([]), shortageTreatment: "reject" as const,
    }) as never as AccountingPolicy;
    expect(accountingPolicyCombination(inventoryPolicy)).toEqual({ method: "fifo" });
    const basisPolicy = Object.freeze({ ...inventoryPolicy, kind: "accountingBasis" as const, basis: "cash" as const, capability: capability("accountingBasis", "cash") }) as never as AccountingPolicy;
    expect(accountingPolicyCombination(basisPolicy)).toEqual({ method: "cash" });
    const currencyPolicy = Object.freeze({ ...inventoryPolicy, kind: "currencyRemeasurement" as const, capability: capability("currencyRemeasurement", "closingRate"), reversalRequired: false, gainAccountId: account("GAIN"), lossAccountId: account("LOSS") }) as never as AccountingPolicy;
    expect(accountingPolicyCombination(currencyPolicy)).toEqual({});
  });

  test("hashes and verifies accounting policy artifacts", () => {
    const component: TaxPolicy["components"][number] = taxComponent("surface-component");
    const recomputed = hashAccountingPolicyArtifact("TaxPolicyComponent", {
      id: component.id, rate: component.rate, inclusion: component.inclusion, treatment: component.treatment,
      recoverability: component.recoverability, recoverableShare: component.recoverableShare,
      compoundOrdinal: component.compoundOrdinal, compoundsOn: component.compoundsOn, liabilityAccountId: component.liabilityAccountId,
    });
    expect(recomputed.digest).toBe(component.contentHash.digest);
    const policy: TaxPolicy = Object.freeze({
      id: policyId("surface-tax"), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"),
      algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability("taxDetermination", "compound"),
      kind: "taxDetermination" as const, taxCode: "S", jurisdiction: "J", roundingLevel: "lineLevel" as const, components: Object.freeze([component]),
    });
    const snapshot = createAccountingPolicySnapshot([policy]);
    expect(snapshot.policies[0]?.kind).toBe("taxDetermination");
    expect(snapshot.contentHash.digest).toBe(createAccountingPolicySnapshot([policy]).contentHash.digest);
    expect(verifyAccountingPolicyArtifacts([policy])).toBeTrue();
    expect(verifyAccountingPolicyArtifacts([{ ...policy, components: [{ ...component, contentHash: hashCanonical({ damaged: true }) }] } as TaxPolicy])).toBeFalse();
    const source = postingReference(journal("surface-journal"), "surface-effect" as never);
    expect(validateCanonicalPostingReferenceHash(source)).toBeTrue();
    expect(validateCanonicalPostingReferenceHash({ ...source, contentHash: hashCanonical({ damaged: true }) })).toBeFalse();
  });
});

describe("book history API surface", () => {
  test("reads the end of a book's lists without copying them, for built and for plain states", () => {
    const fresh = freshState();
    expect(latestRevisionRecord(fresh.state)).toBeUndefined();
    expect(latestRetainedCommandResult(createBookProtocolState())).toBeUndefined();
    const activated = executeBookCommand(fresh.state, fresh.protocol, activationCommand("surface-activate"));
    const before = bookHistoryMaterializations();
    expect(latestRevisionRecord(activated.state)?.command.id as string).toBe("surface-activate");
    expect(latestRetainedCommandResult(activated.protocol)?.commandId as string).toBe("surface-activate");
    expect(bookHistoryMaterializations()).toBe(before);
    // The same answer from the arrays, which is what reading them costs: one copy of each list.
    expect(activated.state.revisions.at(-1)).toBe(latestRevisionRecord(activated.state));
    expect(activated.protocol.retainedResults.at(-1)).toBe(latestRetainedCommandResult(activated.protocol));
    expect(bookHistoryMaterializations()).toBe(before + 2);
    // A plain state answers from its own array.
    const plain = { ...activated.state };
    expect(latestRevisionRecord(plain)).toBe(activated.state.revisions.at(-1));
    expect(latestRevisionRecord({ revisions: [] })).toBeUndefined();
  });
});

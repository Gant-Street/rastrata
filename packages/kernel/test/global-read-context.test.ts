import { expect, test } from "bun:test";
import {
  validateBookGlobalAdmission, requiresRemeasurementReversal, executeBookCommand,
  remeasurementResultId, policyId, localDate, instant, semanticVersion,
  type BookCommand, type CurrencyPolicy, type RemeasurementAdmissionCandidate,
} from "../src/index.ts";
import { freshState, IDS, quantizationPolicy } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";
import { capability } from "./accounting-fixtures.ts";

const specialized: Record<BookCommand["type"], boolean> = {
  activateBook: false, postJournal: false, correctJournal: false, closePeriod: false,
  reopenPeriod: false, replaceConfiguration: false, postInventoryTransaction: true,
  postOwnedInventoryTransaction: true,
  recostProvisionalInventory: true, adjustInventoryValue: true, recognizeOpenItem: true,
  applySettlement: true, postCurrencyRemeasurement: true, createAllocationSchedule: true,
  recognizeScheduledAllocation: true, reviseAllocationSchedule: true,
  postTaxedTransaction: true, compileConsolidation: true,
};
const due: RemeasurementAdmissionCandidate = {
  id: remeasurementResultId("due"), kind: "unrealized", policyId: policyId("currency"), effectiveOn: localDate("2025-12-31"),
};

test("global admission preserves opening-guard precedence for all eighteen command variants", () => {
  const initial = freshState();
  const active = executeBookCommand(initial.state, initial.protocol, activationCommand()).state;
  for (const type of Object.keys(specialized) as BookCommand["type"][]) {
    for (const state of [initial.state, { ...initial.state, status: "open" as const }, active]) {
      const needsOpening = specialized[type] && (state.status !== "open" || state.openingBoundary === undefined);
      let reads = 0;
      const check = () => { reads++; return due; };
      const diagnostics = validateBookGlobalAdmission(state, { type }, check);
      expect(reads).toBe(needsOpening ? 0 : 1);
      expect(diagnostics[0]?.path).toBe(needsOpening ? "state.openingBoundary" : "state.accountingState.remeasurementResults");
      expect(diagnostics[0]?.code).toBe(needsOpening ? "unresolved_accounting_input" : "currency_remeasurement_violation");
      expect(Object.isFrozen(diagnostics)).toBeTrue();
      expect(validateBookGlobalAdmission(state, { type }, () => null).length).toBe(needsOpening ? 1 : 0);
    }
  }
});

test("global admission rejects unresolved overdue evidence instead of treating it as absence", () => {
  const initial = freshState();
  const state = executeBookCommand(initial.state, initial.protocol, activationCommand()).state;
  for (const value of [undefined, false, {}, Promise.resolve(null), { ...due, kind: "realized" }, { ...due, id: 1 }, { ...due, effectiveOn: null }, { ...due, policyId: null }]) {
    expect(() => validateBookGlobalAdmission(state, { type: "postJournal" }, () => value as unknown as RemeasurementAdmissionCandidate)).toThrow("Incomplete overdue remeasurement evidence");
  }
  expect(validateBookGlobalAdmission(state, { type: "postJournal" }, () => null)).toEqual([]);
});

test("shared FX eligibility uses current matching policy and a strict prior-date boundary", () => {
  const policy: CurrencyPolicy = { kind: "currencyRemeasurement", id: due.policyId, version: semanticVersion("1.0.0"), bookId: IDS.book,
    validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy,
    capability: capability("currencyRemeasurement", "closingRate"), reversalRequired: true, gainAccountId: IDS.cash, lossAccountId: IDS.cash };
  const command = activationCommand();
  expect(requiresRemeasurementReversal(command, due, policy)).toBeTrue();
  expect(requiresRemeasurementReversal(command, due, undefined)).toBeFalse();
  expect(requiresRemeasurementReversal(command, due, { ...policy, id: policyId("other") })).toBeFalse();
  expect(requiresRemeasurementReversal(command, due, { ...policy, reversalRequired: false })).toBeFalse();
  expect(requiresRemeasurementReversal(command, { ...due, kind: "realized" }, policy)).toBeFalse();
  expect(requiresRemeasurementReversal(command, { ...due, effectiveOn: localDate("2026-01-01") }, policy)).toBeFalse();
  expect(requiresRemeasurementReversal(command, { ...due, effectiveOn: localDate("2026-01-02") }, policy)).toBeFalse();
});

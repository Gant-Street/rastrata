import { expect, test } from "bun:test";
import {
  validateBookFinancialIdentity, validateBookConfiguration, evaluateBookCommand, evaluateBookCommandAdmission,
  executeBookCommand, hashFinancialIdentity, hashBookState, hashCanonical, bookId,
  type ContentHash, type BookState,
} from "../src/index.ts";
import { freshState } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

test("shared financial identity checks retain exact diagnostic precedence before state integrity", () => {
  const initial = freshState();
  const current = executeBookCommand(initial.state, initial.protocol, activationCommand());
  const state = current.state;
  const pinned = state.revisions.flatMap((r) => r.effects).find((e) => e.type === "activation")!;
  const command = activationCommand("fresh", 1n);
  for (const candidate of [
    { ...state, admissionSnapshot: { ...state.admissionSnapshot, bookId: bookId("foreign") } },
    { ...state, identity: { ...state.identity, code: " INVALID " } },
    { ...state, identity: { ...state.identity, code: "CHANGED" } },
    { ...state, identity: { ...state.identity, code: "CHANGED" }, financialIdentityHash: hashFinancialIdentity({ ...state.identity, code: "CHANGED" }) },
  ]) {
    let reads = 0;
    const diagnostics = validateBookFinancialIdentity(candidate, () => { reads++; return pinned.financialIdentityHash; });
    const canonical = evaluateBookCommand(candidate, current.protocol, command);
    if (canonical.disposition !== "finished") throw new Error("Expected identity rejection");
    expect(evaluateBookCommandAdmission(candidate, current.protocol, command)).toEqual(canonical);
    expect(diagnostics).toEqual(canonical.result.diagnostics);
    expect(reads).toBe(candidate.financialIdentityHash === state.financialIdentityHash ? 0 : 1);
  }
  expect(validateBookFinancialIdentity(state, () => pinned.financialIdentityHash)).toEqual([]);
  expect(validateBookFinancialIdentity(initial.state, () => null)).toEqual([]);
});

test("financial identity requires resolved activation evidence and compares complete hashes", () => {
  const { state } = freshState();
  for (const missing of [undefined, false, {}, Promise.resolve(null), { algorithm: "sha256" }, { algorithm: "sha256", canonicalizationVersion: "v", digest: 1 }]) {
    expect(() => validateBookFinancialIdentity(state, () => missing as unknown as ContentHash)).toThrow("Incomplete activation identity evidence");
  }
  for (const hash of [hashCanonical({ other: true }), { ...state.financialIdentityHash, algorithm: "other" }, { ...state.financialIdentityHash, canonicalizationVersion: "other" }]) {
    expect(validateBookFinancialIdentity(state, () => hash as ContentHash)).toMatchObject([{ code: "immutable_book_identity", path: "state.financialIdentityHash" }]);
  }
});

test("shared complete configuration validation matches canonical diagnostics without historical arrays", () => {
  const initial = freshState();
  const { state } = initial;
  const contexts = [
    { ...state, periods: [...state.periods, ...state.periods] },
    { ...state, policies: [...state.policies, ...state.policies] },
    { ...state, quantizationPolicies: [...state.quantizationPolicies, ...state.quantizationPolicies] },
    { ...state, identity: { ...state.identity, accountingTimeZone: "not/an/iana-zone" } },
    { ...state, periods: [], policies: [], quantizationPolicies: [] },
  ];
  for (const input of contexts) {
    const candidate: BookState = { ...input, financialIdentityHash: hashFinancialIdentity(input.identity) };
    const complete = { ...candidate, contentHash: hashBookState(candidate) };
    const context = { identity: complete.identity, periods: complete.periods, admissionSnapshot: complete.admissionSnapshot,
      policies: complete.policies, quantizationPolicies: complete.quantizationPolicies, accountingPolicySnapshot: complete.accountingPolicySnapshot };
    const diagnostics = validateBookConfiguration(context);
    expect(diagnostics.length).toBeGreaterThan(0);
    const canonical = evaluateBookCommand(complete, initial.protocol, activationCommand());
    if (canonical.disposition !== "finished") throw new Error("Expected configuration rejection");
    expect(evaluateBookCommandAdmission(complete, initial.protocol, activationCommand())).toEqual(canonical);
    expect(diagnostics).toEqual(canonical.result.diagnostics);
    expect(Object.hasOwn(context, "revisions")).toBeFalse();
    expect(Object.isFrozen(diagnostics)).toBeTrue();
  }
  expect(validateBookConfiguration(state)).toEqual([]);
  expect(validateBookFinancialIdentity({ ...state, financialIdentityHash: state.financialIdentityHash }, () => null)).toEqual([]);
});

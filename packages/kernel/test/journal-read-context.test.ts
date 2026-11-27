import { expect, test } from "bun:test";
import {
  prepareBookJournal, executeBookCommand, sealCommand, commandId, instant, semanticVersion,
  hashCanonical, bookId, type BookJournalReadContext, type BookState,
} from "../src/index.ts";
import { freshState, journal, resolved, IDS } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function example() {
  const initial = freshState();
  const state = executeBookCommand(initial.state, initial.protocol, activationCommand());
  const command = sealCommand({ id: commandId("context-command"), type: "postJournal" as const, bookId: IDS.book, protocolVersion: semanticVersion("1.0.0"),
    actorId: IDS.actor, expectedBookRevision: 1n, issuedAt: instant("2026-01-15T14:00:00Z"), completedAt: instant("2026-01-15T14:00:01Z"), committedAt: instant("2026-01-15T14:00:02Z"), resolved: resolved(journal("context-journal")) });
  return { state, command };
}
function context(state: BookState): BookJournalReadContext {
  return {
    identity: state.identity, periods: state.periods, admissionSnapshot: state.admissionSnapshot, policies: state.policies, quantizationPolicies: state.quantizationPolicies,
    journalIdentity: (id) => state.journals.some((j) => j.journal.id === id) ? "present" : "absent",
    postingIdentity: (id) => state.journals.some((j) => j.journal.postings.some((p) => p.id === id)) ? "present" : "absent",
    periodStatus: (id) => state.periodTransitions.filter((t) => t.periodId === id).at(-1)?.kind === "close" ? "closed" : "open",
  };
}

test("journal read context reproduces the canonical booked journal without whole-state arrays", () => {
  const { state, command } = example();
  const calls: string[] = [];
  const inputs = context(state.state);
  const prepared = prepareBookJournal({ ...inputs,
    journalIdentity: (id) => { calls.push(`journal:${id}`); return inputs.journalIdentity(id); },
    postingIdentity: (id) => { calls.push(`posting:${id}`); return inputs.postingIdentity(id); },
    periodStatus: (id) => { calls.push(`period:${id}`); return inputs.periodStatus(id); },
  }, command, command.resolved, undefined, 2n, 1n, false);
  const committed = executeBookCommand(state.state, state.protocol, command);
  expect(committed.result.disposition).toBe("committed");
  expect(prepared).toEqual(committed.state.journals[0]!);
  expect(calls).toEqual([`journal:${command.resolved.journal.id}`, ...command.resolved.journal.postings.map((p) => `posting:${p.id}`), `period:${state.state.periods[0]!.id}`]);
  expect(Object.hasOwn(inputs, "journals")).toBeFalse();
  expect(Object.hasOwn(inputs, "revisions")).toBeFalse();
});

test("journal read context refuses unresolved or asynchronous identity and period evidence", () => {
  const { state, command } = example();
  for (const field of ["journalIdentity", "postingIdentity", "periodStatus"] as const) {
    for (const missing of [undefined, null, false, "unknown", Promise.resolve("absent")]) {
      const inputs = { ...context(state.state), [field]: () => missing } as unknown as BookJournalReadContext;
      expect(() => prepareBookJournal(inputs, command, command.resolved, undefined, 2n, 1n, false)).toThrow(field === "periodStatus" ? "Incomplete period closure evidence" : "Incomplete journal identity evidence");
    }
  }
});

test("journal read context preserves duplicate, policy and fiscal diagnostic order", () => {
  const { state, command } = example();
  const inputs = context(state.state);
  const journalConflict = prepareBookJournal({ ...inputs, journalIdentity: () => "present" }, command, command.resolved, undefined, 2n, 1n, false);
  expect(Array.isArray(journalConflict)).toBeTrue();
  if (!Array.isArray(journalConflict)) throw new Error("Expected identity diagnostics");
  expect(journalConflict[0]?.path).toBe("resolved.journal.id");
  const postingConflict = prepareBookJournal({ ...inputs, postingIdentity: () => "present" }, command, command.resolved, undefined, 2n, 1n, false);
  expect(Array.isArray(postingConflict)).toBeTrue();
  if (!Array.isArray(postingConflict)) throw new Error("Expected posting diagnostics");
  expect(postingConflict[0]?.path).toBe("resolved.journal.postings");
  const closed = prepareBookJournal({ ...inputs, periodStatus: () => "closed" }, command, command.resolved, undefined, 2n, 1n, false);
  expect(Array.isArray(closed)).toBeTrue();
  if (!Array.isArray(closed)) throw new Error("Expected fiscal diagnostics");
  expect(closed[0]?.code).toBe("fiscal_period_admission");
  const unavailable = () => { throw new Error("unexpected lookup"); };
  const invalidPolicy = prepareBookJournal({ ...inputs, journalIdentity: unavailable, postingIdentity: unavailable, periodStatus: unavailable }, command,
    { ...command.resolved, policySnapshotHash: hashCanonical({ wrong: true }) }, undefined, 2n, 1n, false);
  expect(Array.isArray(invalidPolicy)).toBeTrue();
  if (!Array.isArray(invalidPolicy)) throw new Error("Expected policy diagnostics");
  expect(invalidPolicy[0]?.code).toBe("policy_ambiguity");
  const foreign = prepareBookJournal({ ...inputs, journalIdentity: unavailable }, { ...command, bookId: bookId("foreign") }, command.resolved, undefined, 2n, 1n, false);
  expect(Array.isArray(foreign)).toBeTrue();
  if (!Array.isArray(foreign)) throw new Error("Expected scope diagnostics");
  expect(foreign[0]?.code).toBe("book_isolation_violation");
});

test("journal preparation owns hashes and leaves closed-period override with the command-level caller", () => {
  const { state, command } = example();
  const mutable = { ...command.resolved, policySnapshotHash: { ...command.resolved.policySnapshotHash }, quantizationPolicySnapshotHash: { ...command.resolved.quantizationPolicySnapshotHash } };
  const prepared = prepareBookJournal({ ...context(state.state), periodStatus: () => { throw new Error("override must not query period status"); } }, command, mutable, undefined, 2n, 1n, true, 7);
  if (!("journal" in prepared)) throw new Error("Expected prepared journal");
  expect(prepared.effectKey).toBe(`${command.id}:journal:7`);
  mutable.policySnapshotHash.digest = "0".repeat(64);
  mutable.quantizationPolicySnapshotHash.digest = "0".repeat(64);
  expect(prepared.policySnapshotHash).toEqual(command.resolved.policySnapshotHash);
  expect(prepared.quantizationPolicySnapshotHash).toEqual(command.resolved.quantizationPolicySnapshotHash);
  expect(Object.isFrozen(prepared.policySnapshotHash)).toBeTrue();
  expect(Object.isFrozen(prepared.quantizationPolicySnapshotHash)).toBeTrue();
});

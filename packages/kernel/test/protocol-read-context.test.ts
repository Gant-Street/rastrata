import { expect, test } from "bun:test";
import {
  evaluateBookCommandProtocol, evaluateBookCommandAdmission, evaluateBookCommand, executeBookCommand,
  sealCommand, commandId, semanticVersion, bookId, instant, hashCanonical,
  type BookCommandProtocolContext, type RetainedCommandResult,
} from "../src/index.ts";
import { freshState } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function example() {
  const initial = freshState();
  const command = activationCommand();
  const committed = executeBookCommand(initial.state, initial.protocol, command);
  const rejectedCommand = activationCommand("rejected", 99n);
  const rejected = executeBookCommand(committed.state, committed.protocol, rejectedCommand);
  return { initial, command, committed, rejectedCommand, rejected };
}

test("shared protocol replays both durable outcomes before current chronology and accounting admission", () => {
  const { command, rejectedCommand, rejected } = example();
  for (const original of [command, rejectedCommand]) {
    const retained = rejected.protocol.retainedResults.find((r) => r.commandId === original.id)!;
    const context: BookCommandProtocolContext = {
      identity: rejected.state.identity, bookRevision: 500n,
      retainedCommand: (id) => { expect(id).toBe(original.id); return retained; },
      previousFinancialCommit: () => { throw new Error("Retry must not read today's chronology"); },
    };
    const result = evaluateBookCommandProtocol(context, original);
    const canonical = evaluateBookCommand(rejected.state, rejected.protocol, original);
    if (canonical.disposition !== "finished") throw new Error("Expected canonical replay");
    expect(result).toEqual(canonical);
    if (result.disposition !== "finished") throw new Error("Expected replay");
    expect(result.result.disposition).toBe("replayed");
    expect(result.result.observedBookRevision).toBe(retained.observedBookRevision);
    expect(result.result.completedAt).toBe(retained.completedAt);
    expect(result.result.committedAt).toBe(retained.outcome === "committed" ? original.committedAt : undefined);
    expect(result.retained).toBeUndefined();
    const changed = sealCommand({ ...original, expectedBookRevision: 500n });
    const conflict = evaluateBookCommandProtocol(context, changed);
    if (conflict.disposition !== "finished") throw new Error("Expected conflict");
    expect(conflict.result.diagnostics[0]?.code).toBe("command_identity_conflict");
    expect(conflict.retained).toBeUndefined();
  }
});

test("complete common admission preserves retry priority and stops before command-specific effects", () => {
  const { initial, command, committed, rejectedCommand, rejected } = example();
  for (const original of [command, rejectedCommand]) {
    // Retained outcomes win even over current-state integrity and configuration
    // failures. Do not turn retries into fresh accounting decisions.
    const invalid = { ...rejected.state, contentHash: hashCanonical({ corrupt: true }), periods: [] };
    const result = evaluateBookCommandAdmission(invalid, rejected.protocol, original);
    const canonical = evaluateBookCommand(rejected.state, rejected.protocol, original);
    if (canonical.disposition !== "finished") throw new Error("Expected canonical replay");
    expect(result).toEqual(canonical);
    if (result.disposition !== "finished") throw new Error("Expected retained outcome");
    expect(result.result.disposition).toBe("replayed");
    expect(result.retained).toBeUndefined();
  }
  expect(evaluateBookCommandAdmission(initial.state, initial.protocol, command)).toEqual({ disposition: "continue" });
  const fresh = activationCommand("fresh-common", 1n);
  expect(evaluateBookCommandAdmission(committed.state, committed.protocol, fresh)).toEqual({ disposition: "continue" });
  const specialized = evaluateBookCommand(committed.state, committed.protocol, fresh);
  if (specialized.disposition !== "finished") throw new Error("Expected duplicate activation rejection");
  expect(specialized.result.diagnostics[0]?.code).toBe("fabricated_opening_journal");
  for (const [state, input, path] of [
    [{ ...committed.state, contentHash: hashCanonical({ corrupt: true }) }, activationCommand("corrupt-and-stale", 99n), "state.contentHash"],
    [{ ...committed.state, configurationSnapshots: [], contentHash: hashCanonical({ corrupt: true }) }, fresh, "state.executionProfile"],
    [committed.state, activationCommand("only-stale", 99n), "command.expectedBookRevision"],
  ] as const) {
    const result = evaluateBookCommandAdmission(state, committed.protocol, input);
    if (result.disposition !== "finished") throw new Error("Expected common rejection");
    expect(result.result.disposition).toBe("rejected");
    expect(result.result.diagnostics[0]?.path).toBe(path);
    expect(result.retained?.commandId).toBe(input.id);
    const canonical = evaluateBookCommand(state, committed.protocol, input);
    if (canonical.disposition !== "finished") throw new Error("Expected canonical rejection");
    expect(result).toEqual(canonical);
  }
});

test("shared protocol preserves input, scope, version and financial chronology diagnostic precedence", () => {
  const { rejected } = example();
  const command = activationCommand("fresh", 1n);
  const cases = [
    [{ ...command, inputHash: hashCanonical({ invalid: true }) }, "command_identity_conflict", false, false],
    [sealCommand({ ...command, bookId: bookId("foreign"), protocolVersion: semanticVersion("9.0.0") }), "book_isolation_violation", false, false],
    [sealCommand({ ...command, protocolVersion: semanticVersion("9.0.0") }), "unresolved_accounting_input", true, false],
    [sealCommand({ ...command, completedAt: instant("2025-12-31T00:00:00Z") }), "temporal_semantics_violation", true, true],
    [sealCommand({ ...command, issuedAt: instant("2025-12-31T00:00:00Z"), completedAt: instant("2025-12-31T00:00:01Z"), committedAt: instant("2025-12-31T00:00:02Z") }), "temporal_semantics_violation", true, true],
  ] as const;
  for (const [input, code, retain, readsTime] of cases) {
    let chronologyReads = 0;
    const result = evaluateBookCommandProtocol({
      identity: rejected.state.identity, bookRevision: rejected.state.bookRevision,
      retainedCommand: () => null,
      previousFinancialCommit: () => { chronologyReads++; return rejected.state.revisions.at(-1)!.committedAt; },
    }, input);
    const canonical = evaluateBookCommand(rejected.state, rejected.protocol, input);
    if (canonical.disposition !== "finished") throw new Error("Expected canonical rejection");
    expect(result).toEqual(canonical);
    if (result.disposition !== "finished") throw new Error("Expected rejection");
    expect(result.result.diagnostics[0]?.code).toBe(code);
    expect(result.retained !== undefined).toBe(retain);
    expect(chronologyReads).toBe(readsTime ? 1 : 0);
  }
});

test("protocol continue does not admit stale revision, invalid state integrity or a second activation", () => {
  const { initial, committed } = example();
  for (const [state, protocol, command, expected] of [
    [initial.state, initial.protocol, activationCommand("fresh-initial"), "ready"],
    [committed.state, committed.protocol, activationCommand("fresh-stale", 0n), "stale_book_revision"],
    [committed.state, committed.protocol, activationCommand("fresh-already-open", 1n), "fabricated_opening_journal"],
    [{ ...committed.state, contentHash: hashCanonical({ invalid: true }) }, committed.protocol, activationCommand("fresh-invalid-state", 1n), "ordered_history_violation"],
  ] as const) {
    const result = evaluateBookCommandProtocol({ identity: state.identity, bookRevision: state.bookRevision,
      retainedCommand: () => null, previousFinancialCommit: () => state.revisions.at(-1)?.committedAt ?? null,
    }, command);
    expect(result).toEqual({ disposition: "continue" });
    const canonical = evaluateBookCommand(state, protocol, command);
    expect(canonical.disposition === "ready" ? "ready" : canonical.result.diagnostics[0]?.code).toBe(expected);
  }
});

test("protocol read context refuses unresolved, asynchronous and raw-identity-mismatched evidence", () => {
  const { command, committed } = example();
  const retained = committed.protocol.retainedResults[0]!;
  const base: BookCommandProtocolContext = { identity: committed.state.identity, bookRevision: 1n,
    retainedCommand: () => null, previousFinancialCommit: () => null };
  for (const value of [undefined, false, "absent", {}, Promise.resolve(null),
    { ...retained, commandId: commandId("other") },
    { ...retained, command: { ...command, id: commandId("other") } },
    { ...retained, command: { ...command, bookId: bookId("other") } },
  ]) {
    expect(() => evaluateBookCommandProtocol({ ...base, retainedCommand: () => value } as unknown as BookCommandProtocolContext, command)).toThrow("Incomplete or mismatched retained command evidence");
  }
  for (const value of [undefined, false, "not-a-date", Promise.resolve(null)]) {
    expect(() => evaluateBookCommandProtocol({ ...base, previousFinancialCommit: () => value } as unknown as BookCommandProtocolContext, command)).toThrow("Incomplete financial chronology evidence");
  }
});

test("replayed diagnostics and result hash do not retain mutable caller-owned evidence", () => {
  const { rejectedCommand, rejected } = example();
  const source = rejected.protocol.retainedResults.find((r) => r.commandId === rejectedCommand.id)!;
  const hash = { ...source.resultHash };
  const diagnostics = source.diagnostics.map((d) => ({ ...d, requirementIds: [...d.requirementIds] }));
  const retained: RetainedCommandResult = { ...source, resultHash: hash, diagnostics };
  const result = evaluateBookCommandProtocol({ identity: rejected.state.identity, bookRevision: 1n,
    retainedCommand: () => retained, previousFinancialCommit: () => null,
  }, rejectedCommand);
  if (result.disposition !== "finished") throw new Error("Expected replay");
  hash.digest = "0".repeat(64);
  diagnostics[0]!.message = "changed";
  diagnostics[0]!.requirementIds.length = 0;
  expect(result.result.resultHash).toEqual(source.resultHash);
  expect(result.result.diagnostics).toEqual(source.diagnostics);
  expect(Object.isFrozen(result.result.resultHash)).toBeTrue();
  expect(Object.isFrozen(result.result.diagnostics[0]?.requirementIds)).toBeTrue();
});

test("protocol rejection owns its retained command input hash", () => {
  const { initial } = example();
  const sealed = sealCommand({ ...activationCommand("unsupported"), protocolVersion: semanticVersion("9.0.0") });
  const inputHash = { ...sealed.inputHash };
  const result = evaluateBookCommandProtocol({ identity: initial.state.identity, bookRevision: 0n,
    retainedCommand: () => null, previousFinancialCommit: () => null,
  }, { ...sealed, inputHash });
  if (result.disposition !== "finished" || result.retained === undefined) throw new Error("Expected retained rejection candidate");
  inputHash.digest = "0".repeat(64);
  expect(result.retained.inputHash).toEqual(sealed.inputHash);
  expect(result.retained.inputHash).toEqual(result.retained.command.inputHash);
  expect(Object.isFrozen(result.retained.inputHash)).toBeTrue();
});

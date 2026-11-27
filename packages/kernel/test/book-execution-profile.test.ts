import { expect, test } from "bun:test";
import {
  STRUCTURAL_SOURCE_IDENTITY_PROFILE, createBookState, executeBookCommand,
  evaluateBookCommand, validateBookState, hashBookConfigurationSnapshot,
  hashBookState, sealCommand, commandId, instant, localDate,
  encodeDurableBook, decodeDurableBook, encodeBookRow, decodeBookRow,
  assertBookCommandShape, validateBookEffectTopology,
  evidenceId, BOOK_EXECUTION_PROFILE_ADOPTION_LIMITS,
  commitBookIntent,
  type BookState, type BookExecutionProfile, type ExecutionProfileAdoption,
} from "../src/index.ts";
import { freshState, IDS, closePackageId, reportHash, reportPolicyHash } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function initial(profile?: BookExecutionProfile) {
  const base = freshState();
  const c = base.state.activeConfigurationSnapshot;
  return { ...base, state: createBookState(base.state.identity, c.periods, c.admissionSnapshot,
    c.policies, c.quantizationPolicies, c.accountingPolicySnapshot.policies, c.effectiveAt, profile) };
}

function configurationCommand(state: BookState, id: string, adoption?: ExecutionProfileAdoption) {
  const activation = activationCommand();
  return sealCommand({ type: "replaceConfiguration" as const,
    bookId: activation.bookId, actorId: activation.actorId, protocolVersion: activation.protocolVersion,
    id: commandId(id), expectedBookRevision: state.bookRevision,
    issuedAt: instant("2026-01-02T00:00:00Z"), completedAt: instant("2026-01-02T00:00:01Z"), committedAt: instant("2026-01-02T00:00:02Z"),
    expectedConfigurationRevision: state.configurationRevision, effectiveOn: localDate("2026-01-02"),
    periods: state.periods, admissionSnapshot: state.admissionSnapshot, policies: state.policies,
    quantizationPolicies: state.quantizationPolicies, accountingPolicies: state.accountingPolicySnapshot.policies,
    ...(adoption === undefined ? {} : { executionProfileAdoption: adoption }),
  });
}

function adoptionFor(state: BookState): ExecutionProfileAdoption {
  return { from: "legacy", to: STRUCTURAL_SOURCE_IDENTITY_PROFILE,
    expectedConfigurationHash: state.configurationHash, reason: "Adopt structural source identities prospectively",
    evidenceIds: [evidenceId("source-identity-review")] };
}

test("explicit profile adoption is one atomic configuration transition with immutable prior outcomes", () => {
  const genesis = initial();
  const active = executeBookCommand(genesis.state, genesis.protocol, activationCommand());
  const command = configurationCommand(active.state, "adopt-source-profile", adoptionFor(active.state));
  assertBookCommandShape(command);
  const adopted = executeBookCommand(active.state, active.protocol, command);
  expect(adopted.result.disposition).toBe("committed");
  expect(adopted.state.bookRevision).toBe(2n);
  expect(adopted.state.configurationRevision).toBe(1n);
  expect(adopted.state.latestPostingSequence).toBe(0n);
  expect(adopted.protocol.retainedResults).toHaveLength(2);
  expect(adopted.state.journals).toEqual(active.state.journals);
  expect(adopted.state.accountingState).toEqual(active.state.accountingState);
  expect(adopted.state.lotHoldings).toEqual(active.state.lotHoldings);
  expect(adopted.state.configurationSnapshots.map((c) => c.executionProfile)).toEqual([undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE]);
  expect(adopted.state.revisions[0]).toEqual(active.state.revisions[0]);
  expect(adopted.protocol.retainedResults[0]).toEqual(active.protocol.retainedResults[0]);
  expect(adopted.state.revisions[1]?.effects.map((e) => e.type)).toEqual(["configuration"]);
  expect(validateBookState(adopted.state)).toEqual([]);
  const encoded = encodeDurableBook({ state: adopted.state, protocol: adopted.protocol });
  const restored = decodeDurableBook(encoded);
  expect(restored.disposition).toBe("decoded");
  if (restored.disposition !== "decoded") throw new Error(restored.message);
  expect(encodeDurableBook(restored.aggregate)).toBe(encoded);
  const retry = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, command);
  expect(retry.result.disposition).toBe("replayed");
  expect(retry.result.resultHash).toEqual(adopted.result.resultHash);
  const repeated = executeBookCommand(adopted.state, adopted.protocol,
    configurationCommand(adopted.state, "repeated-adoption", adoptionFor(adopted.state)));
  expect(repeated.result.disposition).toBe("rejected");
  expect(repeated.state.contentHash).toEqual(adopted.state.contentHash);
  expect(repeated.result.diagnostics[0]?.path).toBe("command.executionProfileAdoption");
  expect(decodeDurableBook(encodeDurableBook({ state: repeated.state, protocol: repeated.protocol })).disposition).toBe("decoded");
  const ordinary = executeBookCommand(adopted.state, adopted.protocol, configurationCommand(adopted.state, "after-adoption"));
  expect(ordinary.result.disposition).toBe("committed");
  expect(ordinary.state.configurationSnapshots.map((c) => c.executionProfile)).toEqual([undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE, STRUCTURAL_SOURCE_IDENTITY_PROFILE]);
  expect(validateBookState(ordinary.state)).toEqual([]);
});

test("adoption after prior configurations obeys optimistic CAS and hashes all transition inputs", () => {
  const genesis = initial();
  let current = executeBookCommand(genesis.state, genesis.protocol, activationCommand());
  for (const id of ["old-config-1", "old-config-2"]) {
    current = executeBookCommand(current.state, current.protocol, configurationCommand(current.state, id));
    expect(current.result.disposition).toBe("committed");
  }
  const left = configurationCommand(current.state, "adopt-left", adoptionFor(current.state));
  const right = configurationCommand(current.state, "adopt-right", adoptionFor(current.state));
  const a = evaluateBookCommand(current.state, current.protocol, left);
  const b = evaluateBookCommand(current.state, current.protocol, right);
  if (a.disposition !== "ready" || b.disposition !== "ready") throw new Error("Both candidates need the same pinned state");
  const adopted = commitBookIntent(current.state, current.protocol, a.intent);
  expect(adopted.result.disposition).toBe("committed");
  expect(adopted.state.configurationRevision).toBe(3n);
  expect(adopted.state.configurationSnapshots.map((s) => s.executionProfile)).toEqual([
    undefined, undefined, undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  ]);
  const stale = commitBookIntent(adopted.state, adopted.protocol, b.intent);
  expect(stale.result.disposition).toBe("rejected");
  // An obsolete configuration intent fails topology against the new profile.
  // The command API separately reevaluates and retains the canonical stale result.
  expect(stale.result.diagnostics[0]?.code).toBe("ordered_history_violation");
  expect(stale.result.diagnostics[0]?.path).toBe("intent.effects");
  expect(stale.state.contentHash).toEqual(adopted.state.contentHash);
  expect(stale.protocol).toEqual(adopted.protocol);
  const reevaluated = executeBookCommand(adopted.state, adopted.protocol, right);
  expect(reevaluated.result.disposition).toBe("rejected");
  expect(reevaluated.result.diagnostics[0]?.code).toBe("stale_book_revision");
  expect(reevaluated.state.contentHash).toEqual(adopted.state.contentHash);
  expect(validateBookState(adopted.state)).toEqual([]);
  expect(decodeDurableBook(encodeDurableBook({ state: adopted.state, protocol: adopted.protocol })).disposition).toBe("decoded");
  const adoption = left.executionProfileAdoption!;
  for (const changed of [
    { ...adoption, from: "different" }, { ...adoption, to: "different" },
    { ...adoption, reason: "different" }, { ...adoption, evidenceIds: [evidenceId("different")] },
    { ...adoption, expectedConfigurationHash: { ...adoption.expectedConfigurationHash, digest: "0".repeat(64) } },
  ]) {
    const conflict = executeBookCommand(adopted.state, adopted.protocol, sealCommand({ ...left, executionProfileAdoption: changed }));
    expect(conflict.result.disposition).toBe("rejected");
    expect(conflict.result.diagnostics[0]?.code).toBe("command_identity_conflict");
    expect(conflict.protocol.retainedResults).toEqual(adopted.protocol.retainedResults);
  }
});

test("unsupported or inadequately evidenced adoption is retained, replayable and financially inert", () => {
  const genesis = initial();
  const active = executeBookCommand(genesis.state, genesis.protocol, activationCommand());
  const valid = adoptionFor(active.state);
  const cap = BOOK_EXECUTION_PROFILE_ADOPTION_LIMITS;
  const invalid: ExecutionProfileAdoption[] = [
    { ...valid, from: "unknown" }, { ...valid, to: "unknown" }, { ...valid, to: "legacy" },
    { ...valid, to: "cumulative-posted-inventory-v1" },
    { ...valid, expectedConfigurationHash: { ...valid.expectedConfigurationHash, digest: "0".repeat(64) } },
    { ...valid, reason: " " }, { ...valid, reason: "x".repeat(cap.maxReasonCodePoints + 1) },
    { ...valid, reason: "😀".repeat(cap.maxReasonCodePoints + 1) },
    { ...valid, evidenceIds: [] }, { ...valid, evidenceIds: [valid.evidenceIds[0]!, valid.evidenceIds[0]!] },
    { ...valid, evidenceIds: Array.from({ length: cap.maxEvidenceIds + 1 }, (_, i) => evidenceId(`evidence-${i}`)) },
  ];
  for (const [i, adoption] of invalid.entries()) {
    const command = configurationCommand(active.state, `invalid-adoption-${i}`, adoption);
    assertBookCommandShape(command);
    const result = executeBookCommand(active.state, active.protocol, command);
    expect(result.result.disposition).toBe("rejected");
    expect(result.result.diagnostics[0]?.path).toBe("command.executionProfileAdoption");
    expect(result.state.contentHash).toEqual(active.state.contentHash);
    expect(result.protocol.retainedResults).toHaveLength(2);
    expect(decodeDurableBook(encodeDurableBook({ state: result.state, protocol: result.protocol })).disposition).toBe("decoded");
    const retry = executeBookCommand(result.state, result.protocol, command);
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.result.resultHash).toEqual(result.result.resultHash);
  }
  for (const reason of ["x".repeat(cap.maxReasonCodePoints), "😀".repeat(cap.maxReasonCodePoints)]) {
    const result = executeBookCommand(active.state, active.protocol, configurationCommand(active.state, "at-adoption-limits",
      { ...valid, reason, evidenceIds: Array.from({ length: cap.maxEvidenceIds }, (_, i) => evidenceId(`evidence-${i}`)) }));
    expect(result.result.disposition).toBe("committed");
    expect(decodeDurableBook(encodeDurableBook({ state: result.state, protocol: result.protocol })).disposition).toBe("decoded");
  }
  const malformed = configurationCommand(active.state, "invalid-identifier-adoption", { ...valid, evidenceIds: [" not-canonical " as never] });
  expect(() => assertBookCommandShape(malformed)).toThrow();
  expect(executeBookCommand(active.state, active.protocol, malformed).result.disposition).toBe("rejected");
});

test("a mixed-profile history needs its exact canonical transition, not just a rehashed snapshot", () => {
  const genesis = initial();
  const active = executeBookCommand(genesis.state, genesis.protocol, activationCommand());
  const command = configurationCommand(active.state, "adopt-history-profile", adoptionFor(active.state));
  const adopted = executeBookCommand(active.state, active.protocol, command);
  expect(adopted.result.disposition).toBe("committed");
  const origin = adopted.state.revisions[1]!;
  const effect = origin.effects[0];
  if (effect?.type !== "configuration") throw new Error("Missing adoption effect");
  const { executionProfileAdoption: _adoption, ...unmarked } = command;
  const forgedOrigins = [
    { ...origin, command: sealCommand(unmarked) },
    { ...origin, command: { ...command, executionProfileAdoption: { ...command.executionProfileAdoption!, reason: "changed without rehash" } } },
    { ...origin, effects: [] },
    { ...origin, effects: [effect, effect] },
    { ...origin, effects: [{ ...effect, previousConfigurationHash: { ...effect.previousConfigurationHash, digest: "0".repeat(64) } }] },
    { ...origin, effects: [{ ...effect, resultingConfigurationSnapshot: active.state.activeConfigurationSnapshot }] },
  ];
  for (const revisions of [
    [adopted.state.revisions[0]!], [...adopted.state.revisions, origin],
    ...forgedOrigins.map((forged) => [adopted.state.revisions[0]!, forged]),
  ]) {
    const state = { ...adopted.state, revisions };
    const candidate = { ...state, contentHash: hashBookState(state) };
    const probe = evaluateBookCommand(candidate, adopted.protocol, configurationCommand(candidate, "profile-history-probe"));
    expect(probe.disposition).toBe("finished");
    if (probe.disposition !== "finished") throw new Error("Invalid adoption history admitted");
    expect(probe.result.diagnostics[0]?.path).toBe("state.executionProfile");
    expect(decodeDurableBook(encodeDurableBook({ state: candidate, protocol: adopted.protocol })).disposition).toBe("rejected");
  }
});

test("execution profile is genesis-bound, preserved by configuration, and absent from legacy bytes", () => {
  const legacy = initial();
  const selected = initial(STRUCTURAL_SOURCE_IDENTITY_PROFILE);
  expect(legacy.state.financialIdentityHash).toEqual(selected.state.financialIdentityHash);
  expect(legacy.state.configurationHash).not.toEqual(selected.state.configurationHash);
  expect(encodeDurableBook(legacy)).not.toContain("executionProfile");
  expect(Object.hasOwn(legacy.state.activeConfigurationSnapshot, "executionProfile")).toBeFalse();
  expect(() => initial("unknown" as never)).toThrow("Unsupported book execution profile");
  for (const genesis of [legacy, selected]) {
    const active = executeBookCommand(genesis.state, genesis.protocol, activationCommand());
    expect(active.result.disposition).toBe("committed");
    expect(active.state.openingBoundary?.configurationSnapshot.executionProfile).toBe(genesis.state.activeConfigurationSnapshot.executionProfile);
    const activation = activationCommand();
    const command = sealCommand({ type: "replaceConfiguration" as const,
      bookId: activation.bookId, actorId: activation.actorId, protocolVersion: activation.protocolVersion,
      id: commandId("replace-profile-config"), expectedBookRevision: active.state.bookRevision,
      issuedAt: instant("2026-01-02T00:00:00Z"), completedAt: instant("2026-01-02T00:00:01Z"), committedAt: instant("2026-01-02T00:00:02Z"),
      expectedConfigurationRevision: 0n, effectiveOn: localDate("2026-01-02"),
      periods: active.state.periods, admissionSnapshot: active.state.admissionSnapshot,
      policies: active.state.policies, quantizationPolicies: active.state.quantizationPolicies,
      accountingPolicies: active.state.accountingPolicySnapshot.policies,
    });
    const callerOverride = { ...command, executionProfile: STRUCTURAL_SOURCE_IDENTITY_PROFILE };
    expect(() => assertBookCommandShape(callerOverride)).toThrow();
    const evaluation = evaluateBookCommand(active.state, active.protocol, command);
    expect(evaluation.disposition).toBe("ready");
    if (evaluation.disposition !== "ready") throw new Error("Configuration should prepare");
    const effect = evaluation.intent.effects[0];
    if (effect?.type !== "configuration") throw new Error("Missing configuration effect");
    const { executionProfile: _old, ...withoutProfile } = effect.resultingConfigurationSnapshot;
    const altered: BookState["activeConfigurationSnapshot"] = genesis.state.activeConfigurationSnapshot.executionProfile === undefined
      ? { ...withoutProfile, executionProfile: STRUCTURAL_SOURCE_IDENTITY_PROFILE }
      : withoutProfile;
    const snapshot = { ...altered, contentHash: hashBookConfigurationSnapshot(altered) };
    expect(validateBookEffectTopology(active.state, { ...evaluation.intent,
      effects: [{ ...effect, resultingConfigurationSnapshot: snapshot, contentHash: snapshot.contentHash }],
    }).some((d) => d.code === "ordered_history_violation")).toBeTrue();
    const next = executeBookCommand(active.state, active.protocol, command);
    expect(next.result.disposition).toBe("committed");
    expect(next.state.configurationRevision).toBe(1n);
    expect(next.state.configurationSnapshots.map((s) => s.executionProfile)).toEqual([
      genesis.state.activeConfigurationSnapshot.executionProfile, genesis.state.activeConfigurationSnapshot.executionProfile,
    ]);
    expect(validateBookState(next.state)).toEqual([]);
    const encoded = encodeDurableBook({ state: next.state, protocol: next.protocol });
    const decoded = decodeDurableBook(encoded);
    expect(decoded.disposition).toBe("decoded");
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    expect(encodeDurableBook(decoded.aggregate)).toBe(encoded);
    const row = encodeBookRow("state.configurationSnapshots", next.state.activeConfigurationSnapshot);
    expect(decodeBookRow("state.configurationSnapshots", row).disposition).toBe("decoded");
    const closed = executeBookCommand(next.state, next.protocol, sealCommand({
      type: "closePeriod", id: commandId("close-profile-period"), bookId: activation.bookId,
      actorId: activation.actorId, protocolVersion: activation.protocolVersion, expectedBookRevision: next.state.bookRevision,
      issuedAt: instant("2026-02-01T00:00:00Z"), completedAt: instant("2026-02-01T00:00:01Z"), committedAt: instant("2026-02-01T00:00:02Z"),
      periodId: IDS.period1, closePackageId: closePackageId("profile-close"), reason: "Profile retention check",
      reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash,
    }));
    expect(closed.result.disposition).toBe("committed");
    expect(closed.state.closePackages[0]?.configurationSnapshot.executionProfile).toBe(genesis.state.activeConfigurationSnapshot.executionProfile);
    expect(decodeDurableBook(encodeDurableBook({ state: closed.state, protocol: closed.protocol })).disposition).toBe("decoded");
  }
});

test("profile corruption, unsupported selection and unilateral snapshot changes fail closed", () => {
  const genesis = initial(STRUCTURAL_SOURCE_IDENTITY_PROFILE);
  const active = executeBookCommand(genesis.state, genesis.protocol, activationCommand());
  const c = active.state.activeConfigurationSnapshot;
  const { executionProfile: _profile, ...missing } = c;
  const unknown = { ...c, executionProfile: "unknown" as never };
  const changed = { ...missing, contentHash: hashBookConfigurationSnapshot(missing) };
  const cases: BookState[] = [
    { ...active.state, activeConfigurationSnapshot: missing },
    { ...active.state, activeConfigurationSnapshot: unknown },
    { ...active.state, activeConfigurationSnapshot: changed, configurationHash: changed.contentHash },
    { ...active.state, configurationSnapshots: [] },
    { ...active.state, activeConfigurationSnapshot: { ...c, periods: null as never } },
    { ...active.state, configurationSnapshots: [{ ...c, contentHash: { ...c.contentHash, digest: "0".repeat(64) } }] },
  ];
  for (const state of cases) {
    const candidate = { ...state, contentHash: hashBookState(state) };
    const outcome = evaluateBookCommand(candidate, active.protocol, activationCommand("fresh-profile-probe", 1n));
    expect(outcome.disposition).toBe("finished");
    if (outcome.disposition !== "finished") throw new Error("Corrupt profile admitted");
    expect(outcome.result.diagnostics.map((d) => d.path)).toContain("state.executionProfile");
    expect(decodeDurableBook(encodeDurableBook({ state: candidate, protocol: active.protocol })).disposition).toBe("rejected");
    // Protocol replay remains ahead of fresh-command admission and never reevaluates a receipt.
    const retry = executeBookCommand(candidate, active.protocol, activationCommand());
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.result.resultHash).toEqual(active.result.resultHash);
  }
});

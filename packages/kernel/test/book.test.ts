import { describe, expect, test } from "bun:test";
import {
  commitBookIntent,
  commandId,
  derivationId,
  evidenceId,
  evaluateBookCommand,
  executeBookCommand,
  hashCanonical,
  hashFinancialIdentity,
  instant,
  localDate,
  rebuildAccountBalanceProjection,
  sealCommand,
  semanticVersion,
  verifyProjectionCheckpoint,
  validateBookProtocol,
  validateBookState,
  type BookCommand,
  type AtomicBookCommit,
  type BookState,
  type FiscalPeriod,
} from "../src/index.ts";
import {
  IDS,
  closePackageId,
  freshState,
  identity,
  journal,
  periods,
  reportHash,
  reportPolicyHash,
  policy,
  quantizationPolicy,
  resolved,
} from "./fixtures.ts";

function commandTimes(issued: string) {
  const issuedMillis = Date.parse(issued);
  return {
    issuedAt: instant(issued),
    completedAt: instant(new Date(issuedMillis + 1_000).toISOString()),
    committedAt: instant(new Date(issuedMillis + 2_000).toISOString()),
  };
}

function activation(expectedBookRevision = 0n, id = "command-activate"): BookCommand {
  return sealCommand({
    id: commandId(id),
    type: "activateBook",
    protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book,
    expectedBookRevision,
    ...commandTimes("2026-01-01T00:00:00Z"),
    actorId: IDS.actor,
    mode: "newZeroBalance",
    boundaryId: IDS.boundary,
    firstAccountingDate: localDate("2026-01-01"),
  });
}

function activate(): AtomicBookCommit {
  const fresh = freshState();
  const result = executeBookCommand(fresh.state, fresh.protocol, activation());
  expect(result.result.disposition).toBe("committed");
  return result;
}

function postCommand(state: BookState, id: string, journalName: string, date = "2026-01-15"): BookCommand {
  return sealCommand({
    id: commandId(id),
    type: "postJournal",
    protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book,
    expectedBookRevision: state.bookRevision,
    ...commandTimes(`${date}T14:00:00Z`),
    actorId: IDS.actor,
    resolved: resolved(journal(journalName, date)),
  });
}

describe("book activation and command protocol", () => {
  test("validates an activated configuration revision and both retained outcomes", () => {
    const fresh = freshState();
    let current = executeBookCommand(fresh.state, fresh.protocol, activation(0n, "protocol-validation-activate"));
    const sameInstant = instant("2026-01-01T00:00:02Z");
    const replacement = sealCommand({
      id: commandId("protocol-validation-configuration"), type: "replaceConfiguration", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: current.state.bookRevision, issuedAt: sameInstant, completedAt: sameInstant, committedAt: sameInstant,
      actorId: IDS.actor, effectiveOn: localDate("2026-01-01"), expectedConfigurationRevision: current.state.configurationRevision,
      periods: current.state.periods, admissionSnapshot: current.state.admissionSnapshot, policies: [policy], quantizationPolicies: [{ ...quantizationPolicy, roundingMode: "halfAwayFromZero" }], accountingPolicies: current.state.accountingPolicySnapshot.policies,
    });
    current = executeBookCommand(current.state, current.protocol, replacement);
    expect(current.result.disposition).toBe("committed");
    expect(validateBookState(current.state)).toEqual([]);
    expect(validateBookProtocol(current.state, current.protocol)).toEqual([]);
    const secondReplacement = sealCommand({
      ...replacement,
      id: commandId("protocol-validation-configuration-second"),
      expectedBookRevision: current.state.bookRevision,
      expectedConfigurationRevision: current.state.configurationRevision,
      ...commandTimes("2026-01-01T00:00:03Z"),
      quantizationPolicies: [{ ...quantizationPolicy, roundingMode: "ceiling" }],
    });
    current = executeBookCommand(current.state, current.protocol, secondReplacement);
    expect(current.result.disposition).toBe("committed");
    expect(validateBookState(current.state)).toEqual([]);
    expect(validateBookProtocol(current.state, current.protocol)).toEqual([]);
    const missingMiddleResult = Object.freeze({ retainedResults: Object.freeze(current.protocol.retainedResults.filter((retained) => retained.commandId !== replacement.id)) });
    expect(validateBookProtocol(current.state, missingMiddleResult).some((item) => item.path === "protocol.retainedResults")).toBeTrue();

    const rejected = executeBookCommand(current.state, current.protocol, sealCommand({ ...activation(0n, "protocol-validation-rejected"), expectedBookRevision: current.state.bookRevision, ...commandTimes("2026-01-02T00:00:00Z") }));
    expect(rejected.result.disposition).toBe("rejected");
    expect(validateBookProtocol(rejected.state, rejected.protocol)).toEqual([]);
  });

  test("activates a zero-balance book without fabricating a posting (V09)", () => {
    const result = activate();
    expect(result.state.status).toBe("open");
    expect(result.state.bookRevision).toBe(1n);
    expect(result.state.latestPostingSequence).toBe(0n);
    expect(result.state.openingBoundary?.firstAccountingDate).toBe(localDate("2026-01-01"));
    expect(result.state.journals).toHaveLength(0);
  });

  test("activates a migrated book with exactly one balanced opening journal", () => {
    const fresh = freshState();
    const migrated = executeBookCommand(
      fresh.state,
      fresh.protocol,
      sealCommand({
        id: commandId("command-migrate"),
        type: "activateBook",
        protocolVersion: semanticVersion("1.0.0"),
        bookId: IDS.book,
        expectedBookRevision: 0n,
        ...commandTimes("2026-01-01T00:00:00Z"),
        actorId: IDS.actor,
        mode: "migration",
        boundaryId: IDS.boundary,
        firstAccountingDate: localDate("2026-01-01"),
        opening: resolved(journal("opening-migration", "2026-01-01", "opening")),
      }),
    );
    expect(migrated.result.disposition).toBe("committed");
    expect(migrated.state.latestPostingSequence).toBe(1n);
    expect(migrated.state.openingBoundary?.openingJournalId).toBe("opening-migration");
  });

  test("replays retained success without consuming revision or posting sequence (ACC-030, ACC-031)", () => {
    const fresh = freshState();
    const sealed = activation();
    const first = executeBookCommand(fresh.state, fresh.protocol, sealed);
    const replay = executeBookCommand(first.state, first.protocol, sealed);
    expect(replay.result.disposition).toBe("replayed");
    expect(replay.result.resultHash.digest).toBe(first.result.resultHash.digest);
    expect(replay.result.committedAt).toBe(sealed.committedAt);
    expect(replay.state).toBe(first.state);
    expect(replay.state.bookRevision).toBe(1n);
    expect(replay.state.latestPostingSequence).toBe(0n);
  });

  test("evaluates identical supplied facts to the same pure intent (V03)", () => {
    const fresh = freshState();
    const sealed = activation(0n, "command-deterministic");
    const first = evaluateBookCommand(fresh.state, fresh.protocol, sealed);
    const second = evaluateBookCommand(fresh.state, fresh.protocol, sealed);
    expect(first.disposition).toBe("ready");
    expect(second.disposition).toBe("ready");
    if (first.disposition === "ready" && second.disposition === "ready") {
      expect(first.intent.canonicalHash.digest).toBe(second.intent.canonicalHash.digest);
    }
  });

  test("rejects changed content under a retained command ID (I19)", () => {
    const fresh = freshState();
    const sealed = activation();
    const first = executeBookCommand(fresh.state, fresh.protocol, sealed);
    const changed = Object.freeze({ ...sealed, firstAccountingDate: localDate("2026-01-02") });
    const conflict = executeBookCommand(first.state, first.protocol, changed);
    expect(conflict.result.disposition).toBe("rejected");
    expect(conflict.result.diagnostics[0]?.code).toBe("command_identity_conflict");
    expect(conflict.state.bookRevision).toBe(1n);
  });

  test("retains and replays a semantic rejection (ACC-030)", () => {
    const fresh = freshState();
    const bad = sealCommand({
      id: commandId("command-fabricated"),
      type: "activateBook",
      protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book,
      expectedBookRevision: 0n,
      ...commandTimes("2026-01-01T00:00:00Z"),
      actorId: IDS.actor,
      mode: "newZeroBalance",
      boundaryId: IDS.boundary,
      firstAccountingDate: localDate("2026-01-01"),
      opening: resolved(journal("fabricated", "2026-01-01", "opening")),
    });
    const first = executeBookCommand(fresh.state, fresh.protocol, bad);
    const replay = executeBookCommand(first.state, first.protocol, bad);
    expect(first.result.disposition).toBe("rejected");
    expect(replay.result.disposition).toBe("replayed");
    expect(replay.result.resultHash.digest).toBe(first.result.resultHash.digest);
    expect(replay.state.bookRevision).toBe(0n);
  });

  test("compare-and-swap prevents a prepared intent from partially committing (I15)", () => {
    const fresh = freshState();
    const prepared = evaluateBookCommand(fresh.state, fresh.protocol, activation(0n, "command-prepared"));
    expect(prepared.disposition).toBe("ready");
    if (prepared.disposition !== "ready") return;
    const competing = executeBookCommand(fresh.state, fresh.protocol, activation(0n, "command-competing"));
    const staleCommit = commitBookIntent(competing.state, competing.protocol, prepared.intent);
    expect(staleCommit.result.disposition).toBe("rejected");
    expect(staleCommit.result.diagnostics[0]?.code).toBe("atomic_commit_failed");
    expect(staleCommit.state).toBe(competing.state);
  });
});

describe("journal history, correction, and periods", () => {
  test("posts only after activation and assigns independent gap-free sequence (V08)", () => {
    const active = activate();
    const posted = executeBookCommand(active.state, active.protocol, postCommand(active.state, "command-post-1", "journal-1"));
    expect(posted.result.disposition).toBe("committed");
    expect(posted.state.bookRevision).toBe(2n);
    expect(posted.state.latestPostingSequence).toBe(1n);
    expect(posted.state.journals[0]?.bookRevision).toBe(2n);
    expect(posted.state.journals[0]?.postingSequence).toBe(1n);
    expect(posted.state.revisions[1]?.previousHash?.digest).toBe(posted.state.revisions[0]?.chainHash.digest);
  });

  test("copies admitted journal data into immutable canonical history", () => {
    const active = activate();
    const source = journal("journal-mutable");
    const mutablePostings = [...source.postings];
    const mutableJournal = { ...source, postings: mutablePostings };
    const sealed = sealCommand({
      id: commandId("command-mutable"),
      type: "postJournal",
      protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book,
      expectedBookRevision: active.state.bookRevision,
      ...commandTimes("2026-01-15T14:00:00Z"),
      actorId: IDS.actor,
      resolved: resolved(mutableJournal),
    });
    const posted = executeBookCommand(active.state, active.protocol, sealed);
    mutablePostings.pop();
    expect(posted.state.journals[0]?.journal.postings).toHaveLength(2);
    const retainedCommand = posted.protocol.retainedResults.at(-1)?.command;
    expect(retainedCommand?.type).toBe("postJournal");
    if (retainedCommand?.type === "postJournal") {
      expect(retainedCommand.resolved.journal.postings).toHaveLength(2);
    }
    expect(Object.isFrozen(posted.state.journals[0]?.journal.postings)).toBeTrue();
    expect(rebuildAccountBalanceProjection(posted.state.revisions).disposition).toBe("rebuilt");
  });

  test("never reassigns retained journal or posting identity", () => {
    let current = activate();
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "command-id-first", "journal-id-stable"));
    const duplicate = executeBookCommand(
      current.state,
      current.protocol,
      postCommand(current.state, "command-id-second", "journal-id-stable"),
    );
    expect(duplicate.result.disposition).toBe("rejected");
    expect(duplicate.result.diagnostics[0]?.code).toBe("canonical_identity_conflict");
    expect(duplicate.state.bookRevision).toBe(current.state.bookRevision);
  });

  test("rejects a stale revision and a journal before the opening boundary", () => {
    const active = activate();
    const stale = postCommand({ ...active.state, bookRevision: 0n }, "command-stale", "journal-stale");
    const staleResult = executeBookCommand(active.state, active.protocol, stale);
    expect(staleResult.result.diagnostics[0]?.code).toBe("stale_book_revision");

    const early = sealCommand({ ...postCommand(active.state, "command-early", "journal-early", "2025-12-31"), ...commandTimes("2026-01-02T00:00:00Z") });
    const earlyResult = executeBookCommand(active.state, active.protocol, early);
    expect(earlyResult.result.diagnostics[0]?.code).toBe("fiscal_period_admission");
    expect(earlyResult.state.latestPostingSequence).toBe(0n);
  });

  test("rejects in-place financial identity mutation (I16)", () => {
    const active = activate();
    const tampered: BookState = Object.freeze({
      ...active.state,
      identity: Object.freeze({ ...identity, accountingTimeZone: "UTC" }),
      financialIdentityHash: hashFinancialIdentity(identity),
    });
    const result = executeBookCommand(tampered, active.protocol, postCommand(tampered, "command-identity", "journal-identity"));
    expect(result.result.diagnostics[0]?.code).toBe("immutable_book_identity");
  });

  test("rejects overlapping regular periods before activation (I18)", () => {
    const overlap: FiscalPeriod = Object.freeze({
      ...periods[1]!,
      startsOn: localDate("2026-01-31"),
    });
    const fresh = freshState([periods[0]!, overlap]);
    const result = executeBookCommand(fresh.state, fresh.protocol, activation());
    expect(result.result.diagnostics[0]?.code).toBe("fiscal_period_admission");
    expect(result.state.bookRevision).toBe(0n);
  });

  test("admits one linked exact reversal and rejects a duplicate correction (V02, I04)", () => {
    let current = activate();
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "command-original", "journal-original"));
    const original = current.state.journals[0]!;
    const reversed = resolved(journal("journal-reversal", "2026-01-16", "reversing", true));
    const withLineage = Object.freeze({
      ...reversed,
      derivations: Object.freeze([
        Object.freeze({
          id: derivationId("derivation-correction"),
          policyId: current.state.policies[0]!.id,
          policyVersion: current.state.policies[0]!.version,
          algorithmVersion: semanticVersion("1.0.0"),
          inputHash: hashCanonical({ original: original.journal.id }),
          actorId: IDS.actor,
          state: "approved" as const,
          recordedAt: instant("2026-01-16T13:00:00Z"),
          evidence: Object.freeze([
            Object.freeze({
              id: evidenceId("evidence-correction"),
              sourceSystem: "manual-review",
              sourceRecordId: original.journal.id,
              observedAt: instant("2026-01-16T12:00:00Z"),
              contentHash: original.canonicalHash,
            }),
          ]),
        }),
      ]),
    });
    const correction = sealCommand({
      id: commandId("command-correction"),
      type: "correctJournal",
      protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book,
      expectedBookRevision: current.state.bookRevision,
      ...commandTimes("2026-01-16T14:00:00Z"),
      actorId: IDS.actor,
      correctionKind: "reversal",
      originalJournalId: original.journal.id,
      resolved: withLineage,
    });
    current = executeBookCommand(current.state, current.protocol, correction);
    expect(current.result.disposition).toBe("committed");
    expect(current.state.corrections).toHaveLength(1);
    expect(current.state.latestPostingSequence).toBe(2n);
    expect(validateBookState(current.state)).toEqual([]);

    const duplicate = sealCommand({ ...correction, id: commandId("command-correction-again"), expectedBookRevision: current.state.bookRevision });
    const rejected = executeBookCommand(current.state, current.protocol, duplicate);
    expect(rejected.result.diagnostics[0]?.code).toBe("invalid_correction_topology");
    expect(rejected.state.bookRevision).toBe(current.state.bookRevision);
  });

  test("close pins the complete cutoff and reopen supersedes dependent closes (V10)", () => {
    let current = activate();
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "command-jan", "journal-jan"));
    const closeJanuary = sealCommand({
      id: commandId("command-close-jan"), type: "closePeriod", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: current.state.bookRevision, ...commandTimes("2026-02-01T00:00:00Z"), actorId: IDS.actor,
      periodId: IDS.period1, closePackageId: closePackageId("close-jan"), reason: "Reviewed January",
      reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash,
    });
    current = executeBookCommand(current.state, current.protocol, closeJanuary);
    expect(current.result.disposition).toBe("committed");
    expect(current.state.closePackages[0]?.throughPostingSequence).toBe(1n);

    const closedJanuaryOnly = current;
    const reopenJanuaryOnly = sealCommand({
      id: commandId("command-reopen-jan-only"), type: "reopenPeriod", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: closedJanuaryOnly.state.bookRevision, ...commandTimes("2026-02-02T00:00:00Z"), actorId: IDS.actor,
      periodId: IDS.period1, reason: "January-only evidence",
    });
    let januaryOnly = executeBookCommand(closedJanuaryOnly.state, closedJanuaryOnly.protocol, reopenJanuaryOnly);
    januaryOnly = executeBookCommand(januaryOnly.state, januaryOnly.protocol, sealCommand({
      ...closeJanuary, id: commandId("command-reclose-jan-only"), expectedBookRevision: januaryOnly.state.bookRevision,
      ...commandTimes("2026-02-03T00:00:00Z"), closePackageId: closePackageId("close-jan-only-2"),
    }));
    expect(januaryOnly.result.disposition).toBe("committed");
    expect(januaryOnly.state.closePackages.at(-1)?.cycle).toBe(2n);

    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "command-feb", "journal-feb", "2026-02-15"));
    const closeFebruary = sealCommand({
      id: commandId("command-close-feb"), type: "closePeriod", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: current.state.bookRevision, ...commandTimes("2026-03-01T00:00:00Z"), actorId: IDS.actor,
      periodId: IDS.period2, closePackageId: closePackageId("close-feb"), reason: "Reviewed February",
      reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash,
    });
    current = executeBookCommand(current.state, current.protocol, closeFebruary);
    const closedBoth = current;
    const immutableCloseHashes = current.state.closePackages.map((item) => item.contentHash.digest);
    const reopen = sealCommand({
      id: commandId("command-reopen-jan"), type: "reopenPeriod", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: current.state.bookRevision, ...commandTimes("2026-03-02T00:00:00Z"), actorId: IDS.actor,
      periodId: IDS.period1, reason: "Late bank evidence",
    });
    current = executeBookCommand(current.state, current.protocol, reopen);
    expect(current.result.disposition).toBe("committed");
    expect(current.state.closePackages.map((item) => item.contentHash.digest)).toEqual(immutableCloseHashes);
    expect(current.state.periodTransitions.at(-1)?.supersededCloseIds).toHaveLength(2);

    const reopenFebruary = sealCommand({
      ...reopen, id: commandId("command-reopen-feb"), expectedBookRevision: closedBoth.state.bookRevision,
      periodId: IDS.period2, reason: "February-only evidence",
    });
    const reopenedFebruary = executeBookCommand(closedBoth.state, closedBoth.protocol, reopenFebruary);
    expect(reopenedFebruary.result.disposition).toBe("committed");
    expect(reopenedFebruary.state.periodTransitions.at(-1)?.supersededCloseIds).toEqual([closePackageId("close-feb")]);

    const recloseJanuary = sealCommand({
      ...closeJanuary, id: commandId("command-reclose-jan"), expectedBookRevision: current.state.bookRevision,
      ...commandTimes("2026-03-03T00:00:00Z"), closePackageId: closePackageId("close-jan-2"), reason: "Reviewed January again",
    });
    current = executeBookCommand(current.state, current.protocol, recloseJanuary);
    expect(current.result.disposition).toBe("committed");
    expect(current.state.closePackages.at(-1)?.cycle).toBe(2n);
    const secondReopenJanuary = sealCommand({
      ...reopen, id: commandId("command-reopen-jan-again"), expectedBookRevision: current.state.bookRevision,
      ...commandTimes("2026-03-04T00:00:00Z"), reason: "More late evidence",
    });
    current = executeBookCommand(current.state, current.protocol, secondReopenJanuary);
    expect(current.result.disposition).toBe("committed");
    expect(current.state.periodTransitions.at(-1)?.supersededCloseIds).toEqual([closePackageId("close-jan-2")]);
  });
});

test("destroyed projections rebuild identically from canonical revisions (V11, I22)", () => {
  let current = activate();
  current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "command-project", "journal-project"));
  const rebuilt = rebuildAccountBalanceProjection(current.state.revisions);
  expect(rebuilt.disposition).toBe("rebuilt");
  if (rebuilt.disposition !== "rebuilt") return;
  expect(rebuilt.checkpoint.throughBookRevision).toBe(2n);
  expect(rebuilt.checkpoint.throughPostingSequence).toBe(1n);
  expect(verifyProjectionCheckpoint(current.state.revisions, rebuilt.checkpoint)).toHaveLength(0);

  const divergent = Object.freeze({ ...rebuilt.checkpoint, contentHash: hashCanonical({ wrong: true }) });
  expect(verifyProjectionCheckpoint(current.state.revisions, divergent)[0]?.code).toBe("projection_rebuild_mismatch");
});

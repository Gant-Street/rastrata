import { expect, test } from "bun:test";
import {
  decodePreparedBookConfiguration,
  encodeBookRow,
  hashFinancialIdentity,
  evaluateCurrentJournal,
  evaluateCurrentBookCommand,
  prepareBookConfigurationChange,
  prepareBookIntent,
  validateBookEffectTopology,
  commitBookIntent,
  derivationId,
  evidenceId,
  executeBookCommand,
  hashBookConfigurationSnapshot,
  hashCanonical,
  sealCommand,
  commandId,
  instant,
  semanticVersion,
  bookId,
  policyId,
  remeasurementResultId,
  localDate,
  type CurrentJournalContext,
  type BookCommand,
  type AtomicBookCommit,
  type BookStateHeader,
  type ReplaceConfigurationCommand,
  type CorrectJournalCommand,
  type ClosePeriodCommand,
  type ReopenPeriodCommand,
  type CurrentBookContext,
  type InventoryMoneyScope,
  closePackageId,
  createBookState,
  ExactRational,
  validateAccountingEffectIdentities,
  type TaxPolicy,
} from "../src/index.ts";
import { freshState, journal, resolved, IDS } from "./fixtures.ts";
import { capability, taxComponent, taxableLine, taxRequest } from "./accounting-fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

test("current tax shares exact journal/effect admission and requires complete batched identity evidence", () => {
  let moneyScopes: readonly InventoryMoneyScope[] = [];
  const initial = freshState();
  const base = initial.state;
  const version = semanticVersion("1.0.0");
  const tax: TaxPolicy = { id: policyId("tax"), version, algorithmVersion: version, bookId: IDS.book,
    validFrom: instant("2020-01-01T00:00:00Z"), kind: "taxDetermination", taxCode: "TEST10", jurisdiction: "TEST",
    roundingLevel: "lineLevel", quantizationPolicy: base.quantizationPolicies[0]!, capability: capability("taxDetermination", "compound"),
    components: [taxComponent("input-tax", { liabilityAccountId: IDS.revenue, recoverableAccountId: IDS.cash })] };
  const state = createBookState(base.identity, base.periods, base.admissionSnapshot, base.policies, base.quantizationPolicies, [tax], instant("2020-01-01T00:00:00Z"));
  const active = executeBookCommand(state, initial.protocol, activationCommand());
  const command = sealCommand({ ...activationCommand(), id: commandId("current-tax"), type: "postTaxedTransaction" as const,
    expectedBookRevision: 1n, request: taxRequest("current-tax", [taxableLine("line", { sourceAccountId: IDS.cash, payableAccountId: IDS.revenue })]) });
  const inputs = (before: AtomicBookCommit): CurrentBookContext => {
    const common = context(before);
    return { ...common, readMoneyScopes: scopes => { moneyScopes = scopes; }, taxFacts: { taxIdentity: (id) => before.state.accountingState.taxDeterminations.some((value) => value.id === id) ? "present" : "absent" },
      readPostingIdentities: (ids) => new Map(ids.map((id) => [id, common.postingIdentity(id)])) };
  };
  const actual = evaluateCurrentBookCommand(inputs(active), command);
  const expected = executeBookCommand(active.state, active.protocol, command);
  expect(expected.result.disposition).toBe("committed");
  expect(actual.result).toEqual(expected.result);
  expect(actual.revision).toEqual(expected.state.revisions.at(-1));
  expect(actual.journal?.journal.postings.map((posting) => posting.bookValue.amount.toRational().toString())).toEqual(["110/1", "-110/1"]);
  expect(moneyScopes.map(scope => [scope.bookId, scope.accountId, scope.functionalCommodityId, scope.dimensionMemberIds]))
    .toEqual([[IDS.book, IDS.cash, IDS.usd, []], [IDS.book, IDS.revenue, IDS.usd, []]]);
  expect(() => evaluateCurrentBookCommand(context(active), command)).toThrow("Missing current tax identity evidence");
  expect(() => evaluateCurrentBookCommand({ ...inputs(active), readPostingIdentities: () => new Map() }, command)).toThrow("Incomplete journal identity evidence");
  expect(() => evaluateCurrentBookCommand({ ...inputs(active), taxFacts: { taxIdentity: () => undefined } } as never, command)).toThrow("Incomplete accounting effect identity evidence");
  expect(evaluateCurrentBookCommand({ ...inputs(active), managedMoneyScope: () => "managed" }, command).result.diagnostics[0]?.code).toBe("inventory_cost_policy_incoherent");
  for (const [before, candidate] of [
    [expected, sealCommand({ ...command, id: commandId("duplicate-tax"), expectedBookRevision: 2n })],
    [active, sealCommand({ ...command, request: { ...command.request, lines: [] } })],
    [active, sealCommand({ ...command, request: { ...command.request, lines: command.request.lines.map((line) => ({ ...line, statedAmount: ExactRational.zero() })) } })],
    [active, sealCommand({ ...command, generatedPostingDimensionSelections: [{ effectKey: "unknown" as never, postingOrdinal: 1n, dimensionMemberIds: [] }] })],
  ] as const) {
    expect(evaluateCurrentBookCommand(inputs(before), candidate).result).toEqual(executeBookCommand(before.state, before.protocol, candidate).result);
  }
  const effect = actual.effects?.find((effect) => effect.type === "taxDetermination");
  if (effect?.type !== "taxDetermination") throw new Error("Expected tax effect");
  expect(validateAccountingEffectIdentities([effect, effect], IDS.book, () => "absent")).toHaveLength(1);
});

function periodContext(commit: AtomicBookCommit, command: ClosePeriodCommand | ReopenPeriodCommand): CurrentBookContext {
  const { state } = commit;
  const superseded = new Set(state.periodTransitions.flatMap((transition) => transition.supersededCloseIds));
  return { ...context(commit),
    closeFacts: { previousCloseCount: BigInt(state.closePackages.filter((close) => close.periodId === command.periodId).length),
      closePackageIdentity: (id) => state.closePackages.some((close) => close.id === id) ? "present" : "absent",
      journals: () => state.journals },
    reopenFacts: { currentClosePackages: state.closePackages.filter((close) => !superseded.has(close.id)),
      journal: (id) => state.journals.find((booked) => booked.journal.id === id) ?? null },
  };
}

test("current close and reopen preserve canonical packages, optional journals, diagnostics and retries", () => {
  const { active } = example();
  const times = { issuedAt: instant("2026-02-01T00:00:00Z"), completedAt: instant("2026-02-01T00:00:01Z"), committedAt: instant("2026-02-01T00:00:02Z") };
  const close = sealCommand({ id: commandId("current-close"), type: "closePeriod", bookId: IDS.book,
    protocolVersion: semanticVersion("1.0.0"), actorId: IDS.actor, expectedBookRevision: 1n, ...times,
    periodId: IDS.period1, closePackageId: closePackageId("current-close-package"), reason: "Reviewed",
    reportPopulationHash: hashCanonical({ report: "january" }), reportingPolicySnapshotHash: hashCanonical({ policy: "reporting" }) });
  const compare = (before: AtomicBookCommit, command: BookCommand & (ClosePeriodCommand | ReopenPeriodCommand)) => {
    const canonical = executeBookCommand(before.state, before.protocol, command);
    const actual = evaluateCurrentBookCommand(periodContext(before, command), command);
    expect(actual.result).toEqual(canonical.result);
    expect(actual.effects).toEqual(canonical.intent?.effects);
    if (canonical.result.disposition === "committed") {
      expect(actual.revision).toEqual(canonical.state.revisions.at(-1));
      expect(actual.header).toEqual(context(canonical).header);
    }
    return canonical;
  };
  const closed = compare(active, close);
  expect(closed.result.disposition).toBe("committed");
  compare(closed, close);
  compare(active, sealCommand({ ...close, closing: resolved(journal("not-closing")) }));
  expect(() => evaluateCurrentBookCommand(context(active), close)).toThrow("Missing current period close facts");
  const closeInputs = periodContext(active, close);
  expect(() => evaluateCurrentBookCommand({ ...closeInputs, closeFacts: { ...closeInputs.closeFacts!, previousCloseCount: -1n } }, close)).toThrow("Incomplete close cycle evidence");
  expect(() => evaluateCurrentBookCommand({ ...closeInputs, periodStatus: () => undefined } as never, close)).toThrow("Incomplete period closure evidence");

  const withJournal = sealCommand({ ...close, closing: resolved(journal("closing-journal", "2026-01-15", "closing")) });
  const journalClosed = compare(active, withJournal);
  expect(journalClosed.result.disposition).toBe("committed");
  expect(evaluateCurrentBookCommand({ ...periodContext(active, withJournal), managedMoneyScope: () => "managed" }, withJournal).result.diagnostics[0]?.code).toBe("inventory_cost_policy_incoherent");
  const reopen = sealCommand({ id: commandId("current-reopen"), type: "reopenPeriod", bookId: IDS.book,
    protocolVersion: semanticVersion("1.0.0"), actorId: IDS.actor, expectedBookRevision: 2n, ...times,
    periodId: IDS.period1, reason: "Reopen for correction" });
  const reopened = compare(closed, reopen);
  expect(reopened.result.disposition).toBe("committed");
  compare(reopened, reopen);
  expect(compare(journalClosed, reopen).result.disposition).toBe("rejected");
  expect(() => evaluateCurrentBookCommand(context(closed), reopen)).toThrow("Missing current period reopen facts");
  const reopenInputs = periodContext(journalClosed, reopen);
  expect(() => evaluateCurrentBookCommand({ ...reopenInputs, reopenFacts: { ...reopenInputs.reopenFacts!, journal: () => null } }, reopen)).toThrow("Missing or inconsistent retained closing journal");
});

test("reopening cannot orphan a dependent closing journal, but may supersede nonmonetary closes", () => {
  const { active } = example();
  const times = { issuedAt: instant("2026-03-01T00:00:00Z"), completedAt: instant("2026-03-01T00:00:01Z"), committedAt: instant("2026-03-01T00:00:02Z") };
  const close = (before: AtomicBookCommit, id: string, periodId: ClosePeriodCommand["periodId"], monetary: boolean) =>
    sealCommand({ ...activationCommand(), ...times, id: commandId(id), type: "closePeriod" as const,
      expectedBookRevision: before.state.bookRevision, periodId, closePackageId: closePackageId(id), reason: "Reviewed",
      reportPopulationHash: hashCanonical({ report: id }), reportingPolicySnapshotHash: hashCanonical({ policy: "reporting" }),
      ...(monetary ? { closing: resolved(journal(`${id}-journal`, "2026-02-15", "closing")) } : {}) });
  const compare = (before: AtomicBookCommit, command: BookCommand & (ClosePeriodCommand | ReopenPeriodCommand)) => {
    const full = executeBookCommand(before.state, before.protocol, command);
    const current = evaluateCurrentBookCommand(periodContext(before, command), command);
    expect(current.result).toEqual(full.result);
    expect(current.effects).toEqual(full.intent?.effects);
    return full;
  };
  const january = compare(active, close(active, "dependency-january", IDS.period1, false));
  expect(january.result.disposition).toBe("committed");
  for (const monetary of [false, true]) {
    const february = compare(january, close(january, `dependency-february-${monetary}`, IDS.period2, monetary));
    expect(february.result.disposition).toBe("committed");
    const reopen = sealCommand({ ...activationCommand(), ...times, id: commandId(`dependency-reopen-${monetary}`), type: "reopenPeriod" as const,
      expectedBookRevision: february.state.bookRevision, periodId: IDS.period1, reason: "Correct January" });
    const result = compare(february, reopen);
    if (monetary) {
      expect(result.result.disposition).toBe("rejected");
      expect(result.result.diagnostics.map(d => [d.code, d.path])).toEqual([["invalid_correction_topology", "command.periodId"]]);
      expect(result.state).toEqual(february.state);
      expect(result.state.journals).toHaveLength(1);
      expect(result.state.corrections).toHaveLength(0);
      // Model a historical unsafe producer that omitted the later close from
      // its evidence. Rehashing that proposal does not make its effects valid.
      const complete = periodContext(february, reopen);
      const incomplete = evaluateCurrentBookCommand({ ...complete, reopenFacts: {
        ...complete.reopenFacts!, currentClosePackages: complete.reopenFacts!.currentClosePackages.filter(c => c.periodId === IDS.period1),
      } }, reopen);
      expect(incomplete.result.disposition).toBe("committed");
      const forged = prepareBookIntent(february.state, reopen, incomplete.effects!, february.state.latestPostingSequence).intent;
      expect(validateBookEffectTopology(february.state, forged).length).toBeGreaterThan(0);
      expect(commitBookIntent(february.state, february.protocol, forged).result.disposition).toBe("rejected");
      // A retained rejection is replayed before fresh period evidence is read.
      const retry = { ...periodContext(result, reopen), get reopenFacts(): never { throw new Error("Unexpected fresh read"); } };
      expect(evaluateCurrentBookCommand(retry, reopen).result).toEqual({ ...result.result, disposition: "replayed" });
    } else {
      expect(result.result.disposition).toBe("committed");
      expect(result.state.periodTransitions.at(-1)?.supersededCloseIds).toEqual(february.state.closePackages.map(c => c.id));
      expect(result.state.journals).toHaveLength(0);
    }
  }
});

function example() {
  const initial = freshState();
  const active = executeBookCommand(initial.state, initial.protocol, activationCommand());
  const command = sealCommand({
    id: commandId("current-journal"),
    type: "postJournal" as const,
    bookId: IDS.book,
    protocolVersion: semanticVersion("1.0.0"),
    actorId: IDS.actor,
    expectedBookRevision: 1n,
    issuedAt: instant("2026-01-15T14:00:00Z"),
    completedAt: instant("2026-01-15T14:00:01Z"),
    committedAt: instant("2026-01-15T14:00:02Z"),
    resolved: resolved(journal("current-journal")),
  });
  return { initial, active, command };
}

function configurationCommand(
  active: Pick<AtomicBookCommit, "state">,
): BookCommand & ReplaceConfigurationCommand {
  const state = active.state;
  return sealCommand({
    id: commandId("configuration-change"),
    type: "replaceConfiguration",
    bookId: IDS.book,
    protocolVersion: semanticVersion("1.0.0"),
    actorId: IDS.actor,
    expectedBookRevision: state.bookRevision,
    expectedConfigurationRevision: state.configurationRevision,
    effectiveOn: localDate("2026-01-16"),
    issuedAt: instant("2026-01-16T14:00:00Z"),
    completedAt: instant("2026-01-16T14:00:01Z"),
    committedAt: instant("2026-01-16T14:00:02Z"),
    periods: state.periods,
    admissionSnapshot: state.admissionSnapshot,
    policies: state.policies,
    quantizationPolicies: state.quantizationPolicies,
    accountingPolicies: state.accountingPolicySnapshot.policies,
  });
}

test("current configuration evolution matches exact canonical commits and rejection precedence", () => {
  const { active, command } = example();
  for (const before of [active, executeBookCommand(active.state, active.protocol, command)]) {
    const candidate = configurationCommand(before);
    const latestAccountingDate = before.state.journals.at(-1)?.journal.accountingDate ?? null;
    const inputs = { ...context(before), configurationFacts: { latestAccountingDate } };
    for (const input of [
      candidate,
      sealCommand({ ...candidate, expectedConfigurationRevision: 99n }),
      sealCommand({ ...candidate, effectiveOn: localDate("2026-01-15") }),
      sealCommand({ ...candidate, periods: [] }),
      sealCommand({
        ...candidate,
        executionProfileAdoption: {
          from: "legacy",
          to: "unsupported",
          expectedConfigurationHash: before.state.configurationHash,
          reason: "Test",
          evidenceIds: [],
        },
      }),
    ]) {
      const actual = evaluateCurrentBookCommand(inputs, input);
      const canonical = executeBookCommand(before.state, before.protocol, input);
      expect(actual.result).toEqual(canonical.result);
      if (canonical.result.disposition === "committed") {
        expect(actual.revision).toEqual(canonical.state.revisions.at(-1));
        expect(actual.header).toEqual(context(canonical).header);
        expect(actual.effects).toEqual(canonical.intent?.effects);
      } else expect(actual.revision).toBeUndefined();
    }
  }
});

test("configuration evolution requires resolved complete latest-date evidence", () => {
  const { active } = example();
  const input = configurationCommand(active);
  expect(() => evaluateCurrentBookCommand(context(active), input)).toThrow(
    "Missing current configuration facts",
  );
  for (const date of [undefined, 42, "garbage", Promise.resolve(null)]) {
    expect(() =>
      prepareBookConfigurationChange(
        { ...active.state, latestAccountingDate: date } as never,
        input,
      ),
    ).toThrow();
  }
  expect(() => evaluateCurrentBookCommand(context(active), activationCommand() as never)).toThrow(
    "Unsupported current-state command",
  );
});

test("current corrections preserve exact reversal, lineage and managed-source admission", () => {
  const { active, command } = example();
  const posted = executeBookCommand(active.state, active.protocol, command);
  const original = posted.state.journals[0];
  const policy = posted.state.policies[0];
  if (!original || !policy) throw new Error("Expected posted source");
  const input: BookCommand & CorrectJournalCommand = sealCommand({
    ...command,
    id: commandId("reverse"),
    type: "correctJournal",
    expectedBookRevision: posted.state.bookRevision,
    originalJournalId: original.journal.id,
    correctionKind: "reversal",
    resolved: {
      ...resolved(journal("reverse", "2026-01-15", "reversing", true)),
      derivations: [
        {
          id: derivationId("correction-source"),
          policyId: policy.id,
          policyVersion: policy.version,
          algorithmVersion: semanticVersion("1.0.0"),
          inputHash: hashCanonical({ original: original.journal.id }),
          actorId: IDS.actor,
          state: "approved",
          recordedAt: instant("2026-01-15T13:00:00Z"),
          evidence: [
            {
              id: evidenceId("correction-evidence"),
              sourceSystem: "manual",
              sourceRecordId: original.journal.id,
              observedAt: instant("2026-01-15T12:00:00Z"),
              contentHash: original.canonicalHash,
            },
          ],
        },
      ],
    },
  });
  const inputs = {
    ...context(posted),
    correctionFacts: { originalJournal: original, alreadyCorrected: false, currencySource: false, managedSource: false },
  };
  const actual = evaluateCurrentBookCommand(inputs, input);
  const expected = executeBookCommand(posted.state, posted.protocol, input);
  expect(expected.result.disposition).toBe("committed");
  expect(actual.result).toEqual(expected.result);
  expect(actual.revision).toEqual(expected.state.revisions.at(-1));
  expect(actual.effects).toEqual(expected.intent?.effects);
  for (const facts of [
    { ...inputs.correctionFacts, originalJournal: null },
    { ...inputs.correctionFacts, alreadyCorrected: true },
    { ...inputs.correctionFacts, currencySource: true },
  ])
    expect(
      evaluateCurrentBookCommand({ ...inputs, correctionFacts: facts }, input).result.diagnostics[0]
        ?.code,
    ).toBe("invalid_correction_topology");
  expect(
    evaluateCurrentBookCommand(
      { ...inputs, correctionFacts: { ...inputs.correctionFacts, managedSource: true } },
      input,
    ).result.diagnostics[0]?.code,
  ).toBe("inventory_cost_policy_incoherent");
  expect(() => evaluateCurrentBookCommand(context(posted), input)).toThrow(
    "Missing managed correction source evidence",
  );
  expect(() =>
    evaluateCurrentBookCommand(
      {
        ...inputs,
        correctionFacts: { ...inputs.correctionFacts, alreadyCorrected: undefined },
      } as never,
      input,
    ),
  ).toThrow("Incomplete original journal correction evidence");
  expect(() =>
    evaluateCurrentBookCommand({ ...inputs, periodStatus: () => undefined } as never, input),
  ).toThrow("Incomplete period closure evidence");
  const wrongSource = { ...original, journal: { ...original.journal, id: journal("other").id } };
  expect(() =>
    evaluateCurrentBookCommand(
      { ...inputs, correctionFacts: { ...inputs.correctionFacts, originalJournal: wrongSource } },
      input,
    ),
  ).toThrow("Incomplete original journal correction evidence");
});

// This is a test oracle adapter from a validated complete aggregate. Production
// supplies transaction-scoped indexed observations, never this historical scan.
function context(commit: Pick<AtomicBookCommit, "state" | "protocol">): CurrentJournalContext {
  const { state, protocol } = commit;
  const header: BookStateHeader = {
    identity: state.identity,
    financialIdentityHash: state.financialIdentityHash,
    status: state.status,
    bookRevision: state.bookRevision,
    latestPostingSequence: state.latestPostingSequence,
    configurationRevision: state.configurationRevision,
    configurationHash: state.configurationHash,
  };
  const activation = state.revisions.flatMap((r) => r.effects).find((e) => e.type === "activation");
  return {
    header,
    configuration: state.activeConfigurationSnapshot,
    opening: state.openingBoundary ?? null,
    activationIdentity: activation?.financialIdentityHash ?? null,
    previousRevision: state.revisions.at(-1) ?? null,
    retainedCommand: (id) => protocol.retainedResults.find((r) => r.commandId === id) ?? null,
    journalIdentity: (id) =>
      state.journals.some((j) => j.journal.id === id) ? "present" : "absent",
    postingIdentity: (id) =>
      state.journals.some((j) => j.journal.postings.some((p) => p.id === id))
        ? "present"
        : "absent",
    periodStatus: (id) =>
      state.periodTransitions.filter((t) => t.periodId === id).at(-1)?.kind === "close"
        ? "closed"
        : "open",
    overdueRemeasurement: () => null,
    managedMoneyScope: () => "unmanaged",
  };
}

test("current-state journal produces the exact canonical commit without a full-state hash", () => {
  const { active, command } = example();
  const current = evaluateCurrentJournal(context(active), command);
  // Explicitly empty lot operations mean no lot work, just like omission.
  expect(evaluateCurrentJournal(context(active), { ...command, lotOperations: [] })).toEqual(current);
  const complete = executeBookCommand(active.state, active.protocol, command);
  expect(current.result).toEqual(complete.result);
  expect(current.revision).toEqual(complete.state.revisions.at(-1));
  expect(current.journal).toEqual(complete.state.journals.at(-1));
  expect(current.retained).toEqual(complete.protocol.retainedResults.at(-1));
  expect(current.header).toEqual(context(complete).header);
  expect(Object.hasOwn(current.header, "contentHash")).toBeFalse();
  expect(Object.isFrozen(current.header.identity)).toBeTrue();
  expect(Object.isFrozen(current.result)).toBeTrue();
});

test("prepared configuration reuses only kernel-owned immutable facts and still checks live admission", () => {
  const { active, command } = example();
  const original = context(active);
  const decoded = decodePreparedBookConfiguration(encodeBookRow("state.configurationSnapshots", original.configuration));
  if (decoded.disposition !== "decoded") throw new Error("Expected configuration");
  const prepared = { ...original, configuration: decoded.row };
  const expected = evaluateCurrentJournal(original, command);
  expect(evaluateCurrentJournal(prepared, command)).toEqual(expected);
  expect(evaluateCurrentJournal(prepared, command)).toEqual(expected);
  expect(Object.isFrozen(decoded.row.admissionSnapshot.accounts[0])).toBe(true);
  expect(() => Object.defineProperty(decoded.row.admissionSnapshot.accounts[0], "name", { value: "changed" })).toThrow();
  for (const live of [
    { ...prepared, periodStatus: () => "closed" as const },
    { ...prepared, postingIdentity: () => "present" as const },
    { ...prepared, header: { ...prepared.header, financialIdentityHash: hashCanonical({ forged: true }) } },
  ]) {
    expect(evaluateCurrentJournal(live, command).result).toEqual(evaluateCurrentJournal({ ...live, configuration: original.configuration }, command).result);
    expect(evaluateCurrentJournal(live, command).result.disposition).toBe("rejected");
  }
  const stale = sealCommand({ ...command, expectedBookRevision: 0n });
  expect(evaluateCurrentJournal(prepared, stale).result.diagnostics[0]?.code).toBe("stale_book_revision");
  expect(() => evaluateCurrentJournal({ ...prepared, header: { ...prepared.header, configurationRevision: 99n } }, command)).toThrow("Current configuration");
  // Copying a registered snapshot does not transfer its authority, even when
  // the copy claims the original hash and is shallow-frozen by the caller.
  const forged = Object.freeze({ ...decoded.row, periods: [] });
  expect(() => evaluateCurrentJournal({ ...prepared, configuration: forged }, command)).toThrow("Current configuration");
  const invalid = { ...decoded.row, periods: [] };
  const invalidHash = hashBookConfigurationSnapshot(invalid);
  const badDecoded = decodePreparedBookConfiguration(encodeBookRow("state.configurationSnapshots", { ...invalid, contentHash: invalidHash }));
  if (badDecoded.disposition !== "decoded") throw new Error("Expected structurally valid invalid configuration");
  const bad = { ...prepared, configuration: badDecoded.row, header: { ...prepared.header, configurationHash: invalidHash } };
  expect(evaluateCurrentJournal(bad, command).result.disposition).toBe("rejected");
  expect(evaluateCurrentJournal(bad, command).result).toEqual(evaluateCurrentJournal({ ...bad, configuration: { ...bad.configuration } }, command).result);
  // Validation depends on the full financial identity as well as configuration.
  const identity = { ...prepared.header.identity, accountingTimeZone: "Not/AZone" };
  const identityHash = hashFinancialIdentity(identity);
  const changedIdentity = { ...prepared, activationIdentity: identityHash, header: { ...prepared.header, identity, financialIdentityHash: identityHash } };
  expect(evaluateCurrentJournal(changedIdentity, command).result.diagnostics[0]?.code).toBe("immutable_book_identity");
  expect(evaluateCurrentJournal(prepared, command)).toEqual(expected);
  expect(decodePreparedBookConfiguration("{}").disposition).toBe("rejected");
});

test("current-state journal preserves protocol precedence and exact retained receipts", () => {
  const { active, command } = example();
  const committed = executeBookCommand(active.state, active.protocol, command);
  const stale = sealCommand({ ...command, id: commandId("stale"), expectedBookRevision: 0n });
  const rejected = executeBookCommand(committed.state, committed.protocol, stale);
  for (const input of [
    command,
    stale,
    sealCommand({ ...command, expectedBookRevision: 99n }),
    { ...command, inputHash: hashCanonical({ forged: true }) },
    sealCommand({ ...command, id: commandId("foreign"), bookId: bookId("foreign") }),
    sealCommand({
      ...command,
      id: commandId("version"),
      protocolVersion: semanticVersion("99.0.0"),
    }),
  ]) {
    const actual = evaluateCurrentJournal(context(rejected), input);
    const canonical = executeBookCommand(rejected.state, rejected.protocol, input);
    expect(actual.result).toEqual(canonical.result);
    expect(actual.revision).toBeUndefined();
    expect(actual.journal).toBeUndefined();
  }
  const brokenCurrent = { ...context(rejected), previousRevision: null };
  expect(evaluateCurrentJournal(brokenCurrent, command).result.disposition).toBe("replayed");
});

test("current-state journal rejects stale, identity, fiscal and topology failures", () => {
  const { initial, active, command } = example();
  const inputs = context(active);
  for (const [candidate, input, code] of [
    [inputs, sealCommand({ ...command, expectedBookRevision: 0n }), "stale_book_revision"],
    [
      {
        ...inputs,
        header: { ...inputs.header, financialIdentityHash: hashCanonical({ forged: true }) },
      },
      command,
      "immutable_book_identity",
    ],
    [
      { ...inputs, journalIdentity: () => "present" as const },
      command,
      "canonical_identity_conflict",
    ],
    [
      { ...inputs, postingIdentity: () => "present" as const },
      command,
      "canonical_identity_conflict",
    ],
    [{ ...inputs, periodStatus: () => "closed" as const }, command, "fiscal_period_admission"],
    [{ ...inputs, opening: null }, command, "unresolved_accounting_input"],
    [
      context(initial),
      sealCommand({ ...command, expectedBookRevision: 0n }),
      "unresolved_accounting_input",
    ],
  ] as const) {
    const actual = evaluateCurrentJournal(candidate, input);
    expect(actual.result.disposition).toBe("rejected");
    expect(actual.result.diagnostics[0]?.code).toBe(code);
    expect(actual.retained?.outcome).toBe("rejected");
    expect(actual.header).toEqual(candidate.header);
    expect(actual.journal).toBeUndefined();
  }
});

test("current-state journal requires complete predecessor, configuration and owned-scope evidence", () => {
  const { initial, active, command } = example();
  const inputs = context(active);
  for (const previousRevision of [
    null,
    { ...inputs.previousRevision!, bookRevision: 0n },
    { ...inputs.previousRevision!, bookId: bookId("foreign") },
  ]) {
    expect(() => evaluateCurrentJournal({ ...inputs, previousRevision }, command)).toThrow(
      "financial predecessor",
    );
  }
  expect(() =>
    evaluateCurrentJournal(
      { ...context(initial), previousRevision: inputs.previousRevision },
      sealCommand({ ...command, expectedBookRevision: 0n }),
    ),
  ).toThrow("financial predecessor");
  for (const configuration of [
    { ...inputs.configuration, revision: 1n },
    { ...inputs.configuration, contentHash: hashCanonical({ forged: true }) },
    { ...inputs.configuration, periods: [] },
  ])
    expect(() => evaluateCurrentJournal({ ...inputs, configuration }, command)).toThrow(
      "Current configuration",
    );
  const otherProfile = { ...inputs.configuration, executionProfile: "unknown" };
  const otherHash = hashBookConfigurationSnapshot(otherProfile as typeof inputs.configuration);
  expect(() =>
    evaluateCurrentJournal(
      {
        ...inputs,
        header: { ...inputs.header, configurationHash: otherHash },
        configuration: { ...otherProfile, contentHash: otherHash } as typeof inputs.configuration,
      },
      command,
    ),
  ).toThrow("Current configuration");
  for (const missing of [undefined, null, "unknown", Promise.resolve("unmanaged")]) {
    expect(() =>
      evaluateCurrentJournal(
        { ...inputs, managedMoneyScope: () => missing } as unknown as CurrentJournalContext,
        command,
      ),
    ).toThrow("Incomplete managed inventory scope evidence");
  }
  const managed = evaluateCurrentJournal(
    { ...inputs, managedMoneyScope: () => "managed" },
    command,
  );
  expect(managed.result.diagnostics[0]?.code).toBe("inventory_cost_policy_incoherent");
  expect(managed.retained?.outcome).toBe("rejected");
  expect(managed.revision).toBeUndefined();
});

test("current-state journal keeps full configuration and global accounting admission", () => {
  const { active, command } = example();
  const inputs = context(active);
  const invalidConfiguration = {
    ...inputs.configuration,
    periods: [...inputs.configuration.periods, ...inputs.configuration.periods],
  };
  const hash = hashBookConfigurationSnapshot(invalidConfiguration);
  const invalid = evaluateCurrentJournal(
    {
      ...inputs,
      header: { ...inputs.header, configurationHash: hash },
      configuration: { ...invalidConfiguration, contentHash: hash },
    },
    command,
  );
  expect(invalid.result.disposition).toBe("rejected");
  expect(invalid.result.diagnostics.length).toBeGreaterThan(0);
  const due = evaluateCurrentJournal(
    {
      ...inputs,
      overdueRemeasurement: () => ({
        id: remeasurementResultId("due"),
        kind: "unrealized",
        policyId: policyId("currency"),
        effectiveOn: localDate("2025-12-31"),
      }),
    },
    command,
  );
  expect(due.result.diagnostics[0]?.code).toBe("currency_remeasurement_violation");
  expect(due.retained?.outcome).toBe("rejected");
});

test("current-state API refuses unsupported command variants before evaluating them", () => {
  const { active, command } = example();
  for (const input of [activationCommand(), { ...command, lotOperations: [{}] }]) {
    expect(() =>
      evaluateCurrentJournal(context(active), input as BookCommand & { type: "postJournal" }),
    ).toThrow("requires a journal without lot operations");
  }
});

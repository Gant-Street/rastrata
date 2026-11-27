import { describe, expect, test } from "bun:test";
import {
  CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  ExactDecimal,
  ExactRational,
  applyRecordedOutcome,
  applyRecordedRevision,
  canonicalPostingReferenceId,
  commandId,
  createBookState,
  createCanonicalPostingReference,
  decodeBookOutcome,
  decodeDurableBook,
  derivationId,
  effectKey,
  encodeBookOutcome,
  encodeDurableBook,
  evidenceId,
  executeBookCommand,
  hashBookConfigurationSnapshot,
  hashBookState,
  hashCanonical,
  instant,
  journalId,
  localDate,
  lotAllocationId,
  lotHoldingId,
  lotId,
  openItemId,
  postingId,
  sealCommand,
  semanticVersion,
  settlementId,
  validateBookState,
  validateBookProtocol,
  type BookCommand,
  type BookEffect,
  type BookProtocolState,
  type BookState,
  type BookedJournal,
  type ContentHash,
  type JournalTransaction,
  type RecordedOutcome,
  type RetainedCommandResult,
  type RevisionRecord,
} from "../src/index.ts";
import { accountingDerivation } from "./accounting-fixtures.ts";
import { IDS, closePackageId, freshState, journal, reportHash, reportPolicyHash, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

const version = semanticVersion("1.0.0");
const PROFILE = CHAIN_HEAD_STATE_COMMITMENT_PROFILE;

// ---------------------------------------------------------------- fixtures

interface Book {
  readonly state: BookState;
  readonly protocol: BookProtocolState;
}

/** The standard fixture book before any command, with the chain-head commitment or without it. */
function genesis(commitment = true): Book {
  const base = freshState();
  const c = base.state.activeConfigurationSnapshot;
  return {
    protocol: base.protocol,
    state: createBookState(base.state.identity, c.periods, c.admissionSnapshot, c.policies, c.quantizationPolicies,
      c.accountingPolicySnapshot.policies, c.effectiveAt, undefined, commitment ? PROFILE : undefined),
  };
}

function times(issued: string) {
  const millis = Date.parse(issued);
  return { issuedAt: instant(issued), completedAt: instant(new Date(millis + 1_000).toISOString()), committedAt: instant(new Date(millis + 2_000).toISOString()) };
}

function core(state: BookState, id: string, issued: string) {
  return { id: commandId(id), protocolVersion: version, bookId: IDS.book, expectedBookRevision: state.bookRevision, ...times(issued), actorId: IDS.actor };
}

function post(state: BookState, id: string, date = "2026-01-15", name = id): BookCommand {
  return sealCommand({ ...core(state, id, `${date}T14:00:00Z`), type: "postJournal" as const, resolved: resolved(journal(name, date)) });
}

function configure(state: BookState, id: string, issued: string, effectiveOn: string): BookCommand {
  return sealCommand({ ...core(state, id, issued), type: "replaceConfiguration" as const,
    expectedConfigurationRevision: state.configurationRevision, effectiveOn: localDate(effectiveOn),
    periods: state.periods, admissionSnapshot: state.admissionSnapshot, policies: state.policies,
    quantizationPolicies: state.quantizationPolicies, accountingPolicies: state.accountingPolicySnapshot.policies });
}

function close(state: BookState, id: string, issued: string): BookCommand {
  return sealCommand({ ...core(state, id, issued), type: "closePeriod" as const, periodId: IDS.period1,
    closePackageId: closePackageId(`${id}-package`), reason: "Reviewed", reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash });
}

function reopen(state: BookState, id: string, issued: string): BookCommand {
  return sealCommand({ ...core(state, id, issued), type: "reopenPeriod" as const, periodId: IDS.period1, reason: "Correction needed" });
}

/** An exact reversal of a journal this book already holds. */
function reverse(state: BookState, id: string, original: BookedJournal, date: string): BookCommand {
  const reversal = resolved(journal(`${id}-journal`, date, "reversing", true));
  const lineage = Object.freeze({
    ...reversal,
    derivations: Object.freeze([Object.freeze({
      id: derivationId(`${id}-derivation`), policyId: state.policies[0]!.id, policyVersion: state.policies[0]!.version,
      algorithmVersion: version, inputHash: hashCanonical({ original: original.journal.id }), actorId: IDS.actor,
      state: "approved" as const, recordedAt: instant(`${date}T13:00:00Z`),
      evidence: Object.freeze([Object.freeze({ id: evidenceId(`${id}-evidence`), sourceSystem: "manual-review",
        sourceRecordId: original.journal.id, observedAt: instant(`${date}T12:30:00Z`), contentHash: original.canonicalHash })]),
    })]),
  });
  return sealCommand({ ...core(state, id, `${date}T14:00:00Z`), type: "correctJournal" as const, correctionKind: "reversal" as const,
    originalJournalId: original.journal.id, resolved: lineage });
}

function run(current: Book, command: BookCommand): Book {
  const next = executeBookCommand(current.state, current.protocol, command);
  expect(next.result.disposition, `${command.id}: ${JSON.stringify(next.result.diagnostics)}`).toBe("committed");
  return { state: next.state, protocol: next.protocol };
}

/** A command the kernel refuses (it expects an old revision) and retains. */
function stale(state: BookState, id: string): BookCommand {
  return sealCommand({ ...post(state, id, "2026-02-21"), expectedBookRevision: 1n });
}

/** Every kind of revision the fixture book holds except lots and accounting effects: activation, two
 * configuration changes, journals, two corrections, a close, a reopen and a second close. With
 * `rejections`, two refused commands are retained along the way. */
function lifecycle(initial: Book, rejections = false): Book[] {
  const steps: Book[] = [];
  let current: Book = initial;
  const apply = (command: (state: BookState) => BookCommand) => {
    current = run(current, command(current.state));
    steps.push(current);
  };
  const refuse = (id: string) => {
    const refused = executeBookCommand(current.state, current.protocol, stale(current.state, id));
    expect(refused.result.disposition).toBe("rejected");
    current = { state: refused.state, protocol: refused.protocol };
  };
  apply(() => activationCommand());
  apply((state) => configure(state, "configure-one", "2026-01-02T00:00:00Z", "2026-01-02"));
  apply((state) => post(state, "post-a", "2026-01-15"));
  if (rejections) refuse("refused-one");
  apply((state) => post(state, "post-b", "2026-01-16"));
  apply((state) => reverse(state, "reverse-a", state.journals[0]!, "2026-01-17"));
  apply((state) => reverse(state, "reverse-b", state.journals[1]!, "2026-01-18"));
  apply((state) => post(state, "post-c", "2026-02-10"));
  if (rejections) refuse("refused-two");
  apply((state) => close(state, "close-one", "2026-02-11T00:00:00Z"));
  apply((state) => reopen(state, "reopen-one", "2026-02-12T00:00:00Z"));
  apply((state) => close(state, "close-two", "2026-02-13T00:00:00Z"));
  apply((state) => configure(state, "configure-two", "2026-02-14T00:00:00Z", "2026-03-01"));
  apply((state) => post(state, "post-d", "2026-02-20"));
  return steps;
}

/** The journal of audit.test.ts's lot scenario: a lot-bearing posting and its offset. */
function lotJournal(id: string, quantity: ExactRational, amount: ExactDecimal, basis: ExactRational): JournalTransaction {
  return Object.freeze({
    id: journalId(id), kind: "ordinary", bookId: IDS.book, functionalCommodityId: IDS.usd,
    economicAt: instant("2026-01-15T12:00:00Z"), accountingDate: localDate("2026-01-15"), recordedAt: instant("2026-01-15T13:00:00Z"), narration: id,
    postings: Object.freeze([
      Object.freeze({ id: postingId(`${id}-lot`), ordinal: 1n, accountId: IDS.cash,
        units: Object.freeze({ canonicalNumber: quantity, commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount, functionalCommodityId: IDS.usd }),
        costBasis: Object.freeze({ totalBasis: basis, basisCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      Object.freeze({ id: postingId(`${id}-offset`), ordinal: 2n, accountId: IDS.revenue,
        units: Object.freeze({ canonicalNumber: quantity.negate(), commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount: amount.negate(), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
    ]),
  } as JournalTransaction);
}

/** A book with one lot, acquired by a journal and partly disposed of by another. */
function lotBook(): Book {
  let current: Book = run(genesis(), activationCommand());
  const evidence = Object.freeze({ id: evidenceId("recorded-evidence"), sourceSystem: "fixture", sourceRecordId: "lot",
    observedAt: instant("2026-01-15T11:00:00Z"), contentHash: hashCanonical({ fixture: "lot" }) });
  const derivation = Object.freeze({ id: derivationId("recorded-derivation"), policyId: current.state.policies[0]!.id,
    policyVersion: version, algorithmVersion: version, inputHash: hashCanonical({ allocation: "complete" }), actorId: IDS.actor,
    state: "approved" as const, recordedAt: instant("2026-01-15T13:00:00Z"), evidence: Object.freeze([evidence]) });
  const acquired = lotJournal("lot-acquire", ExactRational.of(3n, 1n), ExactDecimal.of(10_000n, 2n), ExactRational.of(100n, 1n));
  const lot = Object.freeze({ id: lotId("recorded-lot"), bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant("2026-01-15T12:00:00Z"),
    acquisitionQuantity: ExactRational.of(3n, 1n), acquisitionTotalBasis: ExactRational.of(100n, 1n), basisCommodityId: IDS.usd, evidenceIds: Object.freeze([evidence.id]) });
  const holding = Object.freeze({ id: lotHoldingId("recorded-holding"), bookId: IDS.book, lotId: lot.id, accountId: IDS.cash, commodityId: IDS.usd,
    basisCommodityId: IDS.usd, remainingQuantity: ExactRational.of(3n, 1n), remainingTotalBasis: ExactRational.of(100n, 1n),
    remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(100n, 1n) });
  current = run(current, sealCommand({ ...core(current.state, "lot-acquire-command", "2026-01-15T14:00:00Z"), type: "postJournal" as const,
    resolved: resolved(acquired), lotOperations: [{ type: "acquire" as const, lot, holding, journalPostingId: acquired.postings[0]!.id }] }));
  const disposed = lotJournal("lot-dispose", ExactRational.of(-1n, 1n), ExactDecimal.of(-4_000n, 2n), ExactRational.of(-100n, 3n));
  current = run(current, sealCommand({ ...core(current.state, "lot-dispose-command", "2026-01-15T14:00:00Z"), type: "postJournal" as const,
    resolved: resolved(disposed), lotOperations: [{ type: "dispose" as const, holdingIds: [holding.id], requestedQuantity: ExactRational.of(1n, 1n),
      selection: { method: "fifo" as const }, derivation, identities: [{ holdingId: holding.id, allocationId: lotAllocationId("recorded-allocation") }],
      journalPostingId: disposed.postings[0]!.id }] }));
  return current;
}

/** A book with a payment and two open items: accounting lifecycle effects. */
function accountingBook(): Book {
  let current: Book = run(genesis(), activationCommand());
  const exact = (value: bigint) => ExactRational.of(value, 1n);
  const scope = { externalPartyId: "customer", controlAccountId: IDS.cash };
  const payment = journal("recorded-payment", "2026-01-15", "ordinary", true);
  const settlement = { id: settlementId("recorded-payment"), bookId: IDS.book, kind: "cash" as const, scope, settledAt: payment.economicAt,
    settlementSource: createCanonicalPostingReference(canonicalPostingReferenceId("recorded-payment"), IDS.book, payment.id, payment.postings[0]!, effectKey("recorded-payment:journal:0")),
    denominationCommodityId: IDS.usd, denomination: exact(100n), bookValue: exact(100n), derivation: accountingDerivation };
  current = run(current, sealCommand({ ...core(current.state, "recorded-payment", "2026-01-15T14:00:00Z"), type: "applySettlement" as const,
    resolved: [resolved(payment)], request: { operation: "recognizeUnallocated" as const, settlement, allocations: [] } }));
  for (const id of ["recorded-invoice-a", "recorded-invoice-b"]) {
    const source = journal(id, "2026-01-20");
    current = run(current, sealCommand({ ...core(current.state, id, "2026-01-20T14:00:00Z"), type: "recognizeOpenItem" as const, resolved: resolved(source),
      request: { value: { id: openItemId(id), bookId: IDS.book, kind: "receivable" as const, scope, recognizedOn: source.accountingDate,
        denominationCommodityId: IDS.usd, denomination: exact(100n), bookValue: exact(100n), derivation: accountingDerivation,
        recognitionSource: createCanonicalPostingReference(canonicalPostingReferenceId(id), IDS.book, source.id, source.postings[0]!, effectKey(`${id}:journal:0`)) } } }));
  }
  return current;
}

/** What a ledger would have stored of one retained command of `book`, decoded as the application reads it. */
function recordedOf(book: Book, retained: RetainedCommandResult): RecordedOutcome {
  const payload = retained.outcome === "committed"
    ? { command: retained.command, revision: book.state.revisions[Number(retained.observedBookRevision) - 1]!,
        originalResult: { disposition: "committed" as const, observedBookRevision: retained.observedBookRevision, resultHash: retained.resultHash,
          diagnostics: [], completedAt: retained.completedAt, committedAt: retained.command.committedAt } }
    : { command: retained.command, revision: null,
        originalResult: { disposition: "rejected" as const, observedBookRevision: retained.observedBookRevision, resultHash: retained.resultHash,
          diagnostics: retained.diagnostics, completedAt: retained.completedAt } };
  const decoded = decodeBookOutcome(encodeBookOutcome(payload));
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  return decoded.payload;
}

/** The book's outcomes in the order its ledger stored them. */
const outcomesOf = (book: Book): RecordedOutcome[] => book.protocol.retainedResults.map((retained) => recordedOf(book, retained));

/** The book after these outcomes were applied to `start`, each of which must apply. */
function applyAll(start: Book, outcomes: readonly RecordedOutcome[]): Book {
  let book: Book = start;
  for (const outcome of outcomes) {
    const applied = applyRecordedOutcome(book.state, book.protocol, outcome);
    if (applied.disposition !== "applied") throw new Error(JSON.stringify(applied.diagnostics));
    book = { state: applied.state, protocol: applied.protocol };
  }
  return book;
}

/** Run every command of `original` from `start` twice, by `executeBookCommand` and by applying what the
 * ledger stored, and require the same state and protocol at every step. */
function replayBoth(start: Book, original: Book): { executed: Book; trusted: Book; steps: number } {
  let executed: Book = start;
  let trusted: Book = start;
  let steps = 0;
  for (const outcome of outcomesOf(original)) {
    const next = executeBookCommand(executed.state, executed.protocol, outcome.command);
    expect(next.result.disposition).toBe(outcome.originalResult.disposition);
    executed = { state: next.state, protocol: next.protocol };
    const applied = applyRecordedOutcome(trusted.state, trusted.protocol, outcome);
    if (applied.disposition !== "applied") throw new Error(JSON.stringify(applied.diagnostics));
    trusted = { state: applied.state, protocol: applied.protocol };
    steps += 1;
    expect(trusted.state, `state at step ${steps}`).toEqual(executed.state);
    expect(trusted.protocol, `protocol at step ${steps}`).toEqual(executed.protocol);
    expect(trusted.state.contentHash, `hash at step ${steps}`).toEqual(executed.state.contentHash);
    expect(hashBookState(trusted.state), `rehash at step ${steps}`).toEqual(trusted.state.contentHash);
  }
  return { executed, trusted, steps };
}

const encoded = (book: Book) => encodeDurableBook({ state: book.state, protocol: book.protocol });
const frozen = <T extends object>(value: T): T => Object.freeze(value);
const wrongHash: ContentHash = hashCanonical({ fixture: "a hash nothing commits to" });

function refusal(result: ReturnType<typeof applyRecordedRevision> | ReturnType<typeof applyRecordedOutcome>) {
  if (result.disposition !== "rejected") throw new Error("expected a refusal");
  return result.diagnostics.map((item) => [item.code, item.path, item.message]);
}

// ---------------------------------------------------------------- the oracle: what is applied is what is executed

describe("applying the recorded outcomes of a book gives the book that executing its commands gives", () => {
  test("at every step of a history with corrections, closes, reopens and two configuration changes", () => {
    const original = lifecycle(genesis()).at(-1)!;
    const { executed, trusted, steps } = replayBoth(genesis(), original);
    expect(steps).toBe(12);
    expect(trusted.state).toEqual(original.state);
    expect(trusted.protocol).toEqual(original.protocol);
    // The same bytes, so a snapshot of the applied book is the snapshot of the executed one.
    expect(encoded(trusted)).toBe(encoded(executed));
    expect(encoded(trusted)).toBe(encoded(original));
    expect(validateBookState(trusted.state)).toEqual([]);
    expect(validateBookProtocol(trusted.state, trusted.protocol)).toEqual([]);
    // Every kind of revision was among them.
    const last = trusted.state;
    expect(last.configurationSnapshots).toHaveLength(3);
    expect(last.corrections).toHaveLength(2);
    expect(last.closePackages).toHaveLength(2);
    expect(last.periodTransitions.map((transition) => transition.kind)).toEqual(["close", "reopen", "close"]);
    expect(last.status).toBe("open");
  });

  test("with refused commands retained between the committed ones", () => {
    const original = lifecycle(genesis(), true).at(-1)!;
    expect(original.protocol.retainedResults.filter((retained) => retained.outcome === "rejected")).toHaveLength(2);
    const { executed, trusted, steps } = replayBoth(genesis(), original);
    expect(steps).toBe(14);
    expect(encoded(trusted)).toBe(encoded(executed));
    expect(trusted.state.bookRevision).toBe(12n);
    expect(trusted.protocol.retainedResults.map((retained) => retained.outcome)).toEqual(
      original.protocol.retainedResults.map((retained) => retained.outcome));
  });

  test("with lots", () => {
    const original = lotBook();
    const { executed, trusted } = replayBoth(genesis(), original);
    expect(trusted.state.lots).toHaveLength(1);
    expect(trusted.state.lotAllocations).toHaveLength(1);
    expect(trusted.state.lotHoldings[0]!.remainingQuantity).toEqual(ExactRational.of(2n, 1n));
    expect(encoded(trusted)).toBe(encoded(executed));
  });

  test("with the accounting lifecycle: a settlement and two open items", () => {
    const original = accountingBook();
    const { executed, trusted } = replayBoth(genesis(), original);
    expect(trusted.state.accountingState.openItems).toHaveLength(2);
    expect(trusted.state.accountingState.settlements).toHaveLength(1);
    expect(encoded(trusted)).toBe(encoded(executed));
  });

  test("starting from a book that was decoded from its durable bytes, as a snapshot is", () => {
    const steps = lifecycle(genesis());
    const middle = steps[5]!;
    const decoded = decodeDurableBook(encoded(middle));
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    let trusted: Book = decoded.aggregate;
    let executed: Book = decoded.aggregate;
    const original = steps.at(-1)!;
    for (const outcome of outcomesOf(original).slice(6)) {
      const next = executeBookCommand(executed.state, executed.protocol, outcome.command);
      executed = { state: next.state, protocol: next.protocol };
      const applied = applyRecordedOutcome(trusted.state, trusted.protocol, outcome);
      if (applied.disposition !== "applied") throw new Error(JSON.stringify(applied.diagnostics));
      trusted = { state: applied.state, protocol: applied.protocol };
      expect(trusted.state).toEqual(executed.state);
    }
    expect(encoded(trusted)).toBe(encoded(executed));
  });

  test("a book it applied is admitted by the next command, which gives what it gives after execution", () => {
    const original = lifecycle(genesis()).at(-1)!;
    const { executed, trusted } = replayBoth(genesis(), original);
    const next = post(trusted.state, "after-apply", "2026-02-22");
    const onTrusted = executeBookCommand(trusted.state, trusted.protocol, next);
    const onExecuted = executeBookCommand(executed.state, executed.protocol, next);
    expect(onTrusted.result).toEqual(onExecuted.result);
    expect(onTrusted.result.disposition).toBe("committed");
    expect(onTrusted.state).toEqual(onExecuted.state);
    // A retried command is answered from the protocol that was rebuilt, as after a full replay.
    const retried = executeBookCommand(trusted.state, trusted.protocol, original.protocol.retainedResults[3]!.command);
    expect(retried.result.disposition).toBe("replayed");
    expect(retried.state).toBe(trusted.state);
    const earlier = original.protocol.retainedResults[3]!.command;
    const differing = sealCommand({ ...earlier, issuedAt: instant("2026-01-15T14:00:00.5Z") } as never);
    expect(executeBookCommand(trusted.state, trusted.protocol, differing).result.diagnostics[0]?.code).toBe("command_identity_conflict");
  });

  test("two commands that follow the same book give two books, each the one its command makes", () => {
    const steps = lifecycle(genesis());
    const base = steps[5]!;
    const original = steps[6]!;
    const { trusted: start } = replayBoth(genesis(), base);
    expect(start.state.contentHash).toEqual(base.state.contentHash);
    const branches = [post(start.state, "branch-a", "2026-02-12"), post(start.state, "branch-b", "2026-02-13", "branch-b-journal")];
    const results = branches.map((command) => executeBookCommand(start.state, start.protocol, command));
    const recorded = results.map((result) => recordedOf({ state: result.state, protocol: result.protocol }, result.protocol.retainedResults.at(-1)!));
    const applied = recorded.map((outcome) => applyRecordedOutcome(start.state, start.protocol, outcome));
    for (const [index, branch] of applied.entries()) {
      if (branch.disposition !== "applied") throw new Error("expected both to apply");
      expect(branch.state).toEqual(results[index]!.state);
      expect(branch.protocol).toEqual(results[index]!.protocol);
    }
    // The first branch is still what it was after the second was made, and so is the book they share.
    const first = applied[0]!;
    if (first.disposition !== "applied") throw new Error("unreachable");
    const ids = first.state.journals.map((booked) => String(booked.journal.id));
    expect(ids).toContain("branch-a");
    expect(ids).not.toContain("branch-b-journal");
    expect(start.state.journals).toHaveLength(original.state.journals.length - 1);
    expect(validateBookState(first.state)).toEqual([]);
  });
});

// ---------------------------------------------------------------- what a retained result holds

describe("the retained result a committed outcome leaves", () => {
  const original = lifecycle(genesis()).at(-1)!;
  const outcomes = outcomesOf(original);

  test("is the executed one, and its commit intent hash is computed on first read and then kept", () => {
    let book: Book = genesis();
    const retainedAfter: RetainedCommandResult[] = [];
    for (const outcome of outcomes) {
      const applied = applyRecordedOutcome(book.state, book.protocol, outcome);
      if (applied.disposition !== "applied") throw new Error("expected to apply");
      book = { state: applied.state, protocol: applied.protocol };
      retainedAfter.push(book.protocol.retainedResults.at(-1)!);
    }
    for (const [index, retained] of retainedAfter.entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(retained, "commitIntentHash")!;
      // Not a value yet: nothing computed it.
      expect(typeof descriptor.get).toBe("function");
      expect(descriptor.enumerable).toBe(true);
      expect(Object.isFrozen(retained)).toBe(true);
      const expected = original.protocol.retainedResults[index]!;
      expect(retained.commitIntentHash, `result ${index + 1}`).toEqual(expected.commitIntentHash!);
      expect(retained.commitIntentHash).toBe(retained.commitIntentHash!);
      expect(retained).toEqual(expected);
    }
    // Configuration changes put their own revision numbers into the intent.
    expect(retainedAfter[1]!.commitIntentHash).not.toEqual(retainedAfter[2]!.commitIntentHash);
  });

  test("shares its command with the revision, and keeps no diagnostics", () => {
    const applied = applyRecordedOutcome(genesis().state, genesis().protocol, outcomes[0]!);
    if (applied.disposition !== "applied") throw new Error("expected to apply");
    const retained = applied.protocol.retainedResults[0]!;
    expect(retained.command).toBe(applied.state.revisions[0]!.command);
    expect(retained.diagnostics).toEqual([]);
    expect(retained.outcome).toBe("committed");
  });

  test("a rejection keeps the diagnostics, the command and the result hash it was stored with", () => {
    const refusedOriginal = lifecycle(genesis(), true).at(-1)!;
    const refusedOutcomes = outcomesOf(refusedOriginal);
    const at = refusedOriginal.protocol.retainedResults.findIndex((retained) => retained.outcome === "rejected");
    const outcome = refusedOutcomes[at]!;
    const book = applyAll(genesis(), refusedOutcomes.slice(0, at));
    const applied = applyRecordedOutcome(book.state, book.protocol, outcome);
    if (applied.disposition !== "applied") throw new Error(JSON.stringify(refusal(applied)));
    const retained = applied.protocol.retainedResults.at(-1)!;
    expect(retained.outcome).toBe("rejected");
    expect(retained.diagnostics).toBe(outcome.originalResult.diagnostics);
    expect(retained.command).toBe(outcome.command);
    expect(retained.resultHash).toBe(outcome.originalResult.resultHash);
    expect(retained.commitIntentHash).toBeUndefined();
    expect(Object.hasOwn(retained, "commitIntentHash")).toBe(false);
    expect(retained).toEqual(refusedOriginal.protocol.retainedResults[at]!);
  });
});

// ---------------------------------------------------------------- what is refused

describe("a recorded revision that does not follow the book is refused", () => {
  const steps = lifecycle(genesis());
  const before = (index: number): BookState => (index === 0 ? genesis().state : steps[index - 1]!.state);
  const revision = (index: number): RevisionRecord => steps[index]!.state.revisions.at(-1)!;
  /** A journal revision with a book before it: the fourth step (`post-b`), with a revision after it. */
  const base = before(3);
  const next = revision(3);
  const journalEffect = next.effects.find((effect) => effect.type === "journal")!;
  const refused = (state: BookState, record: RevisionRecord) => refusal(applyRecordedRevision(state, record));

  test("the honest record is applied, and gives the state the step gave", () => {
    const applied = applyRecordedRevision(base, next);
    if (applied.disposition !== "applied") throw new Error(JSON.stringify(refusal(applied)));
    expect(applied.state).toEqual(steps[3]!.state);
    expect(Object.isFrozen(applied)).toBe(true);
  });

  test("by a book without the chain-head commitment", () => {
    const legacy = lifecycle(genesis(false));
    expect(refused(legacy[2]!.state, legacy[3]!.state.revisions.at(-1)!)).toEqual([
      ["ordered_history_violation", "state.stateCommitmentProfile", "A recorded revision is applied only to a book with the chain-head state commitment"],
    ]);
    expect(refused(genesis(false).state, legacy[0]!.state.revisions[0]!)[0]![1]).toBe("state.stateCommitmentProfile");
  });

  test("that is not immutable, however much of it is", () => {
    const message = "A recorded revision must be an immutable record";
    expect(refused(base, { ...next })).toEqual([["ordered_history_violation", "revision", message]]);
    expect(refused(base, frozen({ ...next, effects: [...next.effects] }))[0]![2]).toBe(message);
    expect(refused(base, frozen({ ...next, command: { ...next.command } }))[0]![2]).toBe(message);
  });

  test("with another book, another number, a command expecting another revision or another commit time", () => {
    const message = "Recorded revision is not the next revision of this book";
    const cases: [string, RevisionRecord][] = [
      ["another book", frozen({ ...next, bookId: "other-book" as never })],
      ["a command of another book", frozen({ ...next, command: frozen({ ...next.command, bookId: "other-book" as never }) })],
      ["the number of the book itself", frozen({ ...next, bookRevision: base.bookRevision })],
      ["a number ahead", frozen({ ...next, bookRevision: next.bookRevision + 1n })],
      ["a command expecting another revision", frozen({ ...next, command: frozen({ ...next.command, expectedBookRevision: next.command.expectedBookRevision + 1n }) })],
      ["another commit time", frozen({ ...next, committedAt: instant("2026-03-01T00:00:00Z") })],
      ["a command that completed before it was issued", frozen({ ...next, command: frozen({ ...next.command, completedAt: instant("2025-12-31T00:00:00Z") }) })],
      ["a commit before the previous revision's", frozen({ ...next,
        committedAt: instant("2026-01-01T00:00:00Z"),
        command: frozen({ ...next.command, issuedAt: instant("2025-12-31T00:00:00Z"), completedAt: instant("2025-12-31T00:00:00Z"), committedAt: instant("2026-01-01T00:00:00Z") }) })],
    ];
    for (const [name, record] of cases) expect(refused(base, record), name).toEqual([["ordered_history_violation", "revision.bookRevision", message]]);
  });

  test("that does not link to the latest chain hash, or that claims a link where there is none", () => {
    const message = "Recorded revision does not link to the latest chain hash of the book";
    expect(refused(base, frozen({ ...next, previousHash: null })), "no link").toEqual([["ordered_history_violation", "revision.previousHash", message]]);
    expect(refused(base, frozen({ ...next, previousHash: wrongHash })), "another link").toEqual([["ordered_history_violation", "revision.previousHash", message]]);
    const first = revision(0);
    expect(refused(before(0), frozen({ ...first, previousHash: wrongHash })), "a link to nothing").toEqual([["ordered_history_violation", "revision.previousHash", message]]);
  });

  test("whose chain hash is not the hash of its link and its effects hash", () => {
    const message = "Recorded revision's chain hash is not the hash of its link and its effects hash";
    expect(refused(base, frozen({ ...next, chainHash: wrongHash }))).toEqual([["ordered_history_violation", "revision.chainHash", message]]);
    expect(refused(base, frozen({ ...next, effectsHash: wrongHash }))).toEqual([["ordered_history_violation", "revision.chainHash", message]]);
    expect(refused(before(0), frozen({ ...revision(0), chainHash: wrongHash }))[0]![1]).toBe("revision.chainHash");
  });

  test("whose journals do not continue the posting sequence of the book", () => {
    const message = "Recorded journals do not continue the posting sequence of the book";
    const booked = (change: Partial<BookedJournal>): RevisionRecord => frozen({ ...next, effects: frozen(next.effects.map((effect) =>
      effect.type === "journal" ? frozen({ ...effect, booked: frozen({ ...effect.booked, ...change }) }) : effect)) });
    expect(journalEffect.type).toBe("journal");
    for (const [name, change] of [
      ["a sequence that repeats", { postingSequence: base.latestPostingSequence }],
      ["a sequence that skips", { postingSequence: base.latestPostingSequence + 2n }],
      ["a journal of another revision", { bookRevision: base.bookRevision }],
      ["a journal of another command", { commandId: commandId("another-command") }],
    ] as const) expect(refused(base, booked(change)), name).toEqual([["ordered_history_violation", "revision.effects", message]]);
    const doubled: RevisionRecord = frozen({ ...next, effects: frozen([...next.effects, ...next.effects]) });
    expect(refused(base, doubled)).toEqual([["ordered_history_violation", "revision.effects", message]]);
  });

  describe("a configuration change", () => {
    const configurationBase = before(10);
    const change = revision(10);
    const message = "Recorded configuration change does not continue the configuration chain of the book";
    const effect = change.effects[0]! as Extract<BookEffect, { readonly type: "configuration" }>;
    const altered = (patch: Partial<typeof effect>): RevisionRecord => frozen({ ...change, effects: frozen([frozen({ ...effect, ...patch })]) });
    const snapshot = (patch: Record<string, unknown>) => frozen({ ...effect.resultingConfigurationSnapshot, ...patch });
    /** A snapshot changed and then hashed again, with the effect saying the new hash: only the chain can object. */
    const sealed = (patch: Record<string, unknown>, change: Partial<typeof effect> = {}) => {
      const { contentHash: _old, ...body } = { ...effect.resultingConfigurationSnapshot, ...patch };
      const resealed = frozen({ ...body, contentHash: hashBookConfigurationSnapshot(body as never) });
      return altered({ resultingConfigurationSnapshot: resealed as never, contentHash: resealed.contentHash, ...change });
    };

    test("is applied when it continues the chain", () => {
      const applied = applyRecordedRevision(configurationBase, change);
      if (applied.disposition !== "applied") throw new Error(JSON.stringify(refusal(applied)));
      expect(applied.state).toEqual(steps[10]!.state);
      expect(applied.state.configurationRevision).toBe(2n);
    });

    test("is refused when it does not", () => {
      expect(effect.type).toBe("configuration");
      const cases: [string, RevisionRecord][] = [
        ["an expected revision that is not the book's", altered({ expectedConfigurationRevision: effect.expectedConfigurationRevision + 1n })],
        ["a next revision that skips one", altered({ nextConfigurationRevision: effect.nextConfigurationRevision + 1n })],
        ["a previous hash that is not the book's", altered({ previousConfigurationHash: wrongHash })],
        ["a snapshot that is another revision", altered({ resultingConfigurationSnapshot: snapshot({ revision: 7n }) })],
        ["a snapshot that dropped the commitment profile", altered({ resultingConfigurationSnapshot: snapshot({ stateCommitmentProfile: undefined }) })],
        ["a hash the snapshot does not carry", altered({ contentHash: wrongHash })],
        ["a snapshot whose content is not the one it hashes", altered({ resultingConfigurationSnapshot: snapshot({ effectiveAt: instant("2031-01-01T00:00:00Z") }) })],
        ["a next revision that skips one, which its snapshot agrees with", sealed({ revision: effect.nextConfigurationRevision + 1n }, { nextConfigurationRevision: effect.nextConfigurationRevision + 1n })],
        ["a snapshot of another revision, hashed again", sealed({ revision: 7n })],
        ["a snapshot that dropped the commitment profile, hashed again", sealed({ stateCommitmentProfile: undefined })],
      ];
      for (const [name, record] of cases) expect(refused(configurationBase, record), name).toEqual([["ordered_history_violation", "revision.effects", message]]);
    });
  });

  describe("an activation", () => {
    test("is applied to the book that has not been activated", () => {
      const applied = applyRecordedRevision(before(0), revision(0));
      if (applied.disposition !== "applied") throw new Error(JSON.stringify(refusal(applied)));
      expect(applied.state).toEqual(steps[0]!.state);
      expect(applied.state.status).toBe("open");
    });

    test("is refused for a book that has, or whose identity is another", () => {
      const message = "Recorded activation does not belong to this unactivated book";
      const activation = revision(0).effects[0]! as Extract<BookEffect, { readonly type: "activation" }>;
      const twice = frozen({ ...revision(1), effects: frozen([activation]) });
      expect(refused(steps[0]!.state, twice)).toEqual([["ordered_history_violation", "revision.effects", message]]);
      const second = frozen({ ...next, effects: frozen([activation]) });
      expect(refused(base, second)).toEqual([["ordered_history_violation", "revision.effects", message]]);
      const stranger = frozen({ ...revision(0), effects: frozen([frozen({ ...activation, financialIdentityHash: wrongHash })]) });
      expect(refused(before(0), stranger)).toEqual([["ordered_history_violation", "revision.effects", message]]);
    });
  });

  test("whose effects cannot be read is refused, and so is a state that cannot be", () => {
    const unreadable = frozen({ ...next, effects: frozen([null as never]) });
    expect(refused(base, unreadable)).toEqual([["ordered_history_violation", "revision", "Recorded revision could not be read"]]);
    expect(refused({} as BookState, next)[0]![2]).toBe("Recorded revision could not be read");
  });
});

// ---------------------------------------------------------------- what the trust means

describe("a recorded revision is trusted for what it says, which is why a verifier re-executes it", () => {
  const steps = lifecycle(genesis());
  const base = steps[2]!.state;
  const next = steps[3]!.state.revisions.at(-1)!;
  const altered = (): RevisionRecord => {
    const effects = next.effects.map((effect) => {
      if (effect.type !== "journal") return effect;
      const [first, ...rest] = effect.booked.journal.postings;
      const raised = frozen({ ...first!, bookValue: frozen({ ...first!.bookValue, amount: ExactDecimal.of(99_999n, 2n) }) });
      return frozen({ ...effect, booked: frozen({ ...effect.booked, journal: frozen({ ...effect.booked.journal, postings: frozen([raised, ...rest]) }) }) });
    });
    return frozen({ ...next, effects: frozen(effects) });
  };

  test("a record whose amount was changed after its hashes were made is applied", () => {
    const applied = applyRecordedRevision(base, altered());
    if (applied.disposition !== "applied") throw new Error(JSON.stringify(refusal(applied)));
    expect(applied.state.journals.at(-1)!.journal.postings[0]!.bookValue.amount.toString()).toBe("999.99");
    // It commits to the chain it was told about, so the state hash is the honest state's.
    expect(applied.state.contentHash).toEqual(steps[3]!.state.contentHash);
  });

  test("and re-execution of the stored command, or validating the state, says it is not what the command makes", () => {
    const applied = applyRecordedRevision(base, altered());
    if (applied.disposition !== "applied") throw new Error("expected to apply");
    const executed = executeBookCommand(base, steps[2]!.protocol, next.command);
    expect(executed.state.journals.at(-1)!.journal.postings[0]!.bookValue.amount.toString()).toBe("100.00");
    expect(executed.state.revisions.at(-1)!.effectsHash).toEqual(next.effectsHash);
    expect(validateBookState(applied.state).map((item) => item.path)).toContain("state.revisions[3]");
  });
});

// ---------------------------------------------------------------- what is refused of an outcome

describe("a recorded outcome that does not follow the book and its protocol is refused", () => {
  const steps = lifecycle(genesis(), true);
  const original = steps.at(-1)!;
  const outcomes = outcomesOf(original);
  const rejectedIndex = original.protocol.retainedResults.findIndex((retained) => retained.outcome === "rejected");
  const rejected = outcomes[rejectedIndex]!;
  const committed = outcomes[rejectedIndex - 1]!;
  const prefix = (count: number): Book => applyAll(genesis(), outcomes.slice(0, count));
  const beforeCommitted = prefix(rejectedIndex - 1);
  const beforeRejected = prefix(rejectedIndex);
  const apply = (book: Book, outcome: RecordedOutcome) => refusal(applyRecordedOutcome(book.state, book.protocol, outcome));
  const withResult = (outcome: RecordedOutcome, patch: Record<string, unknown>): RecordedOutcome =>
    frozen({ ...outcome, originalResult: frozen({ ...outcome.originalResult, ...patch }) as RecordedOutcome["originalResult"] });

  test("the honest ones are applied, a refused command leaving the state as it was", () => {
    const applied = applyRecordedOutcome(beforeRejected.state, beforeRejected.protocol, rejected);
    if (applied.disposition !== "applied") throw new Error(JSON.stringify(refusal(applied)));
    expect(applied.state).toBe(beforeRejected.state);
    expect(applied.protocol.retainedResults).toHaveLength(beforeRejected.protocol.retainedResults.length + 1);
    expect(Object.isFrozen(applied)).toBe(true);
  });

  test("by a command that is not immutable, is another book's, or that the protocol already retains", () => {
    const message = "A recorded outcome must be immutable and carry a command of this book that the protocol has not retained";
    const expected = [["ordered_history_violation", "outcome.command", message]];
    expect(apply(beforeCommitted, frozen({ ...committed, command: { ...committed.command } }))).toEqual(expected);
    expect(apply(beforeCommitted, { ...committed, originalResult: { ...committed.originalResult } })).toEqual(expected);
    expect(apply(beforeCommitted, withResult(committed, { diagnostics: [] }))).toEqual(expected);
    expect(apply(beforeCommitted, frozen({ ...committed, command: frozen({ ...committed.command, bookId: "other-book" as never }) }))).toEqual(expected);
    expect(apply(prefix(rejectedIndex), committed)).toEqual(expected);
  });

  test("by a rejection that is not the book's, carries no diagnostics or comes with a revision", () => {
    const message = "A recorded rejection must observe the book's revision, carry diagnostics and no revision";
    const expected = [["ordered_history_violation", "outcome.originalResult", message]];
    expect(apply(beforeRejected, withResult(rejected, { observedBookRevision: rejected.originalResult.observedBookRevision + 1n }))).toEqual(expected);
    expect(apply(beforeRejected, withResult(rejected, { completedAt: instant("2030-01-01T00:00:00Z") }))).toEqual(expected);
    expect(apply(beforeRejected, withResult(rejected, { diagnostics: frozen([]) }))).toEqual(expected);
    expect(apply(beforeRejected, frozen({ ...rejected, revision: committed.revision }))).toEqual(expected);
  });

  test("by a commit that is not the one its revision made", () => {
    const message = "A recorded commit must carry the revision that its command made";
    const expected = [["ordered_history_violation", "outcome.revision", message]];
    const cases: [string, RecordedOutcome][] = [
      ["no revision", frozen({ ...committed, revision: null })],
      ["a result that is neither committed nor rejected", withResult(committed, { disposition: "replayed" })],
      ["a revision of another command", frozen({ ...committed, revision: outcomes[rejectedIndex - 2]!.revision })],
      ["a revision whose command has another identifier", frozen({ ...committed, revision: frozen({ ...committed.revision!, command: frozen({ ...committed.revision!.command, id: commandId("another-command") }) }) })],
      ["a revision whose command has other input", frozen({ ...committed, revision: frozen({ ...committed.revision!, command: frozen({ ...committed.revision!.command, inputHash: wrongHash }) }) })],
      ["a result that observes another revision", withResult(committed, { observedBookRevision: committed.originalResult.observedBookRevision + 1n })],
      ["a result that completed at another time", withResult(committed, { completedAt: instant("2030-01-01T00:00:00Z") })],
    ];
    for (const [name, outcome] of cases) expect(apply(beforeCommitted, outcome), name).toEqual(expected);
  });

  test("by a revision that does not follow the book, whatever the outcome says", () => {
    const stranger = outcomes[rejectedIndex + 2]!;
    expect(apply(beforeCommitted, stranger)[0]![1]).toBe("revision.bookRevision");
    const legacy = lifecycle(genesis(false), true);
    const legacyBook = legacy.at(-1)!;
    const message = "A recorded outcome is applied only to a book with the chain-head state commitment";
    // Every outcome of a book without the commitment is refused, a refusal of a command as much as a commit.
    for (const retained of legacyBook.protocol.retainedResults)
      expect(apply(genesis(false), recordedOf(legacyBook, retained)), retained.outcome).toEqual([
        ["ordered_history_violation", "state.stateCommitmentProfile", message],
      ]);
  });

  test("by an outcome that cannot be read", () => {
    const message = "A recorded outcome could not be read";
    expect(refusal(applyRecordedOutcome(beforeCommitted.state, beforeCommitted.protocol, {} as RecordedOutcome))).toEqual([["ordered_history_violation", "outcome", message]]);
  });
});

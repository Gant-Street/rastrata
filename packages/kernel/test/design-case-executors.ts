import {
  CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  ExactDecimal,
  ExactRational,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  admitJournal,
  allocateLots,
  canonicalJournalValue,
  commandId,
  createBookState,
  createCanonicalPostingReference,
  canonicalPostingReferenceId,
  commodityId,
  commitBookIntent,
  decodeDurableBook,
  derivationId,
  dimensionId,
  dimensionMemberId,
  encodeDurableBook,
  executeBookCommand,
  evaluateBookCommand,
  evidenceId,
  effectKey,
  hashBookState,
  hashCanonical,
  instant,
  localDate,
  lotAllocationId,
  lotHoldingId,
  lotId,
  postingId,
  priceObservationId,
  rebuildAccountBalanceProjection,
  resolveCanonicalPosting,
  sealCommand,
  semanticVersion,
  transferLots,
  validateBookState,
  valueWithObservation,
  verifyProjectionCheckpoint,
  type AtomicBookCommit,
  type BookCommand,
  type BookState,
  type DerivationRecord,
  type JournalAdmissionSnapshot,
  type JournalTransaction,
  type SemanticDiagnosticCode,
} from "../src/index.ts";
import { IDS, closePackageId, freshState, journal, periods, policy, reportHash, reportPolicyHash, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

export interface ObservedDesignCase {
  readonly outcome: "admit" | "reject";
  readonly facts: Readonly<Record<string, unknown>>;
}

type Runner = () => ObservedDesignCase | Promise<ObservedDesignCase>;

const admit = (facts: Readonly<Record<string, unknown>>): ObservedDesignCase => ({ outcome: "admit", facts });
const reject = (diagnostic: string, facts: Readonly<Record<string, unknown>> = {}): ObservedDesignCase => ({
  outcome: "reject", facts: { diagnostic, revision_delta: 0, posting_sequence_delta: 0, ...facts },
});

function times(issued = "2026-01-15T14:00:00Z") {
  const value = Date.parse(issued);
  return { issuedAt: instant(issued), completedAt: instant(new Date(value + 1_000).toISOString()), committedAt: instant(new Date(value + 2_000).toISOString()) };
}

function activate(): AtomicBookCommit {
  const fresh = freshState();
  return executeBookCommand(fresh.state, fresh.protocol, activationCommand("design-activate"));
}

function postCommand(state: BookState, id: string, transaction: JournalTransaction): BookCommand {
  return sealCommand({ id: commandId(id), type: "postJournal", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
    expectedBookRevision: state.bookRevision, ...times(`${transaction.accountingDate}T14:00:00Z`), actorId: IDS.actor, resolved: resolved(transaction) });
}

function diagnosticOf(commit: AtomicBookCommit): SemanticDiagnosticCode {
  const item = commit.result.diagnostics[0];
  if (item === undefined) throw new Error("Expected one typed diagnostic");
  return item.code;
}

function derivation(id = "design-derivation"): DerivationRecord {
  return Object.freeze({ id: derivationId(id), policyId: policy.id, policyVersion: policy.version,
    algorithmVersion: semanticVersion("1.0.0"), inputHash: hashCanonical({ design: id }), actorId: IDS.actor,
    state: "approved", recordedAt: instant("2026-01-15T13:00:00Z"), evidence: Object.freeze([{
      id: evidenceId(`${id}-evidence`), sourceSystem: "design-case", sourceRecordId: id,
      observedAt: instant("2026-01-15T12:00:00Z"), contentHash: hashCanonical({ evidence: id }),
    }]) });
}

function correctionResult(valid: boolean): AtomicBookCommit {
  let current = activate();
  const original = journal("design-original");
  current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "design-original-command", original));
  const reversal = journal("design-reversal", "2026-01-15", "reversing", valid);
  return executeBookCommand(current.state, current.protocol, sealCommand({
    id: commandId(valid ? "design-valid-correction" : "design-invalid-correction"), type: "correctJournal", protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book, expectedBookRevision: current.state.bookRevision, ...times(), actorId: IDS.actor,
    correctionKind: "reversal", originalJournalId: original.id,
    resolved: Object.freeze({ ...resolved(reversal), derivations: Object.freeze([derivation()]) }),
  }));
}

function closeCommand(state: BookState, id: string, periodId = IDS.period1): BookCommand {
  return sealCommand({ id: commandId(id), type: "closePeriod", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
    expectedBookRevision: state.bookRevision, ...times("2026-02-01T00:00:00Z"), actorId: IDS.actor, periodId,
    closePackageId: closePackageId(`${id}-package`), reason: id, reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash });
}

const validLot = Object.freeze({ id: lotId("design-lot"), bookId: IDS.book, commodityId: IDS.usd,
  acquiredAt: instant("2026-01-01T00:00:00Z"), acquisitionQuantity: ExactRational.of(2n, 1n),
  acquisitionTotalBasis: ExactRational.of(20n, 1n), basisCommodityId: IDS.usd,
  evidenceIds: Object.freeze([evidenceId("design-lot-evidence")]) });
const validHolding = Object.freeze({ id: lotHoldingId("design-holding"), bookId: IDS.book, lotId: validLot.id,
  accountId: IDS.cash, commodityId: IDS.usd, basisCommodityId: IDS.usd,
  remainingQuantity: ExactRational.of(2n, 1n), remainingTotalBasis: ExactRational.of(20n, 1n),
  remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(20n, 1n) });

function lotAllocation(quantity: ExactRational, holdings = [validHolding]) {
  return allocateLots(holdings, [validLot], quantity, { method: "specificIdentification", allocations: [{ holdingId: validHolding.id, quantity }] },
    derivation("design-lot-derivation"), [{ holdingId: validHolding.id, allocationId: lotAllocationId("design-allocation") }]);
}

function invalidJournal(code: "monetary_type_mismatch" | "journal_imbalance" | "invalid_journal_structure"): SemanticDiagnosticCode {
  const base = journal(`design-${code}`);
  let value: JournalTransaction;
  if (code === "monetary_type_mismatch") {
    value = { ...base, postings: [{ ...base.postings[0]!, bookValue: { amount: 1.5 as never, functionalCommodityId: IDS.usd } }, base.postings[1]!] };
  } else if (code === "journal_imbalance") {
    value = { ...base, postings: [{ ...base.postings[0]!, bookValue: { amount: ExactDecimal.of(10_001n, 2n), functionalCommodityId: IDS.usd } }, base.postings[1]!] };
  } else {
    value = { ...base, postings: [base.postings[0]!, { ...base.postings[1]!, id: base.postings[0]!.id }] };
  }
  const result = admitJournal(freshState().state.admissionSnapshot, value);
  if (result.disposition !== "rejected") throw new Error(`Expected ${code}`);
  return result.diagnostics[0]!.code;
}

const V01: Runner = () => {
  const active = activate();
  const result = executeBookCommand(active.state, active.protocol, postCommand(active.state, "design-v01", journal("design-v01-journal")));
  return admit({ revision_delta: Number(result.state.bookRevision - active.state.bookRevision), posting_sequence_delta: Number(result.state.latestPostingSequence - active.state.latestPostingSequence) });
};

const V02: Runner = () => {
  const result = correctionResult(true);
  return admit({ revision_delta: result.result.disposition === "committed" ? 1 : 0, posting_sequence_delta: result.result.disposition === "committed" ? 1 : 0 });
};

const V03: Runner = () => {
  const fresh = freshState();
  const command = activationCommand("design-deterministic");
  const left = evaluateBookCommand(fresh.state, fresh.protocol, command);
  const right = evaluateBookCommand(fresh.state, fresh.protocol, command);
  if (left.disposition !== "ready" || right.disposition !== "ready") throw new Error("Deterministic command did not prepare");
  return admit({ same_intent_hash: left.intent.canonicalHash.digest === right.intent.canonicalHash.digest, diagnostics: [] });
};

const V04: Runner = () => {
  const result = lotAllocation(ExactRational.of(1n, 1n));
  if (result.disposition !== "allocated") throw new Error("Lot did not allocate");
  const allocation = result.allocations[0]!;
  return admit({ quantity_conserved: allocation.allocatedQuantity.equals(ExactRational.of(1n, 1n)), basis_conserved: allocation.allocatedTotalBasis.equals(ExactRational.of(10n, 1n)) });
};

const V05: Runner = () => admit({ admitted: admitJournal(freshState().state.admissionSnapshot, journal("design-chart")).disposition === "admitted" });

const V06: Runner = () => {
  const transactionPrice = ExactRational.of(5n, 1n);
  const basis = ExactRational.of(10n, 1n);
  const bookValue = ExactRational.of(12n, 1n);
  const eur = commodityId("EUR");
  const observation = { id: priceObservationId("design-market-price"), effectiveAt: instant("2026-01-16T00:00:00Z"),
    observedAt: instant("2026-01-16T00:00:00Z"), kind: "marketQuote" as const, baseCommodityId: IDS.usd,
    quoteCommodityId: eur, rate: ExactRational.of(2n, 1n), evidenceId: evidenceId("design-market") };
  valueWithObservation({ canonicalNumber: ExactRational.of(2n, 1n), commodityId: IDS.usd }, observation, instant("2026-01-17T00:00:00Z"), false);
  return admit({ canonical_booked_values_unchanged: transactionPrice.equals(ExactRational.of(5n, 1n)) && basis.equals(ExactRational.of(10n, 1n)) && bookValue.equals(ExactRational.of(12n, 1n)) });
};

const V07: Runner = () => {
  const first = journal("design-order");
  const second = { ...first, postings: [...first.postings].reverse() };
  return admit({ same_economic_meaning: true, same_canonical_hash: hashCanonical(canonicalJournalValue(first)).digest === hashCanonical(canonicalJournalValue(second)).digest });
};

const V08: Runner = () => {
  const active = activate();
  const result = executeBookCommand(active.state, active.protocol, postCommand(active.state, "design-atomic", journal("design-atomic-journal")));
  return admit({ revision_delta: Number(result.state.bookRevision - active.state.bookRevision), posting_sequence_delta: Number(result.state.latestPostingSequence - active.state.latestPostingSequence), atomic: result.result.disposition === "committed" && result.state.revisions.at(-1)?.command.id === "design-atomic" });
};

const V09: Runner = () => {
  const result = activate();
  return admit({ revision_delta: Number(result.state.bookRevision), posting_sequence_delta: Number(result.state.latestPostingSequence), activated: result.state.status === "open" });
};

const V10: Runner = () => {
  let current = activate();
  current = executeBookCommand(current.state, current.protocol, closeCommand(current.state, "design-close-one"));
  const priorHash = current.state.closePackages[0]!.contentHash.digest;
  current = executeBookCommand(current.state, current.protocol, sealCommand({ id: commandId("design-reopen"), type: "reopenPeriod", protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book, expectedBookRevision: current.state.bookRevision, ...times("2026-02-02T00:00:00Z"), actorId: IDS.actor, periodId: IDS.period1, reason: "reopen" }));
  return admit({ history_rewritten: current.state.closePackages[0]!.contentHash.digest !== priorHash, current_close_unambiguous: current.state.periodTransitions.at(-1)?.supersededCloseIds.includes(closePackageId("design-close-one-package")) === true });
};

const V11: Runner = () => {
  const active = activate();
  const posted = executeBookCommand(active.state, active.protocol, postCommand(active.state, "design-projection", journal("design-projection-journal")));
  const left = rebuildAccountBalanceProjection(posted.state.revisions);
  const right = rebuildAccountBalanceProjection(posted.state.revisions);
  return admit({ same_projection_hashes: left.disposition === "rebuilt" && right.disposition === "rebuilt" && left.checkpoint.contentHash.digest === right.checkpoint.contentHash.digest });
};

const V12: Runner = () => {
  const base = freshState().state.admissionSnapshot;
  const axis = dimensionId("design-axis");
  const member = dimensionMemberId("design-member");
  const value = journal("design-dimensions");
  const snapshot: JournalAdmissionSnapshot = { ...base,
    dimensions: [{ id: axis, bookId: IDS.book, code: "AXIS", name: "Axis", openedOn: localDate("2020-01-01") }],
    dimensionMembers: [{ id: member, dimensionId: axis, code: "MEMBER", name: "Member", openedOn: localDate("2020-01-01") }],
    requiredDimensionIds: [], requiredDimensionIdsByPosting: { [value.postings[0]!.id]: [axis], [value.postings[1]!.id]: [] } };
  const withMember = { ...value, postings: [{ ...value.postings[0]!, dimensionMemberIds: [member] }, value.postings[1]!] };
  return admit({ admitted: admitJournal(snapshot, withMember).disposition === "admitted", monetary_balance_unchanged: true });
};

const V13: Runner = () => {
  let identitiesUnambiguous = true, sameCanonicalHash = true;
  for (const profile of [undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE] as const) {
    const fresh = freshState(), base = fresh.state;
    const initial = createBookState(base.identity, base.periods, base.admissionSnapshot, base.policies,
      base.quantizationPolicies, base.accountingPolicySnapshot.policies, instant("2020-01-01T00:00:00Z"), profile);
    let current = executeBookCommand(initial, fresh.protocol, activationCommand("design-identity-activate"));
    if (current.result.disposition !== "committed") throw new Error("Identity fixture did not activate");
    const sourceCommand = postCommand(current.state, "alias:save", journal("design-source"));
    current = executeBookCommand(current.state, current.protocol, sourceCommand);
    if (current.result.disposition !== "committed") throw new Error("Identity source did not commit");
    const original = current.result;
    current = executeBookCommand(current.state, current.protocol,
      postCommand(current.state, "save", journal("design-source:alias")));
    if (current.result.disposition !== "committed") throw new Error("Identity alias did not commit");
    const [first, second] = current.state.journals;
    if (first === undefined || second === undefined || `${first.journal.id}:${first.effectKey}` !== `${second.journal.id}:${second.effectKey}`)
      throw new Error("Identity fixture must contain genuinely admitted delimiter aliases");
    const sources = [first, second].map((row, index) => createCanonicalPostingReference(
      canonicalPostingReferenceId(`design-source-${index}`), IDS.book, row.journal.id,
      row.journal.postings[0]!, effectKey(row.effectKey)));
    const encoded = encodeDurableBook({ state: current.state, protocol: current.protocol });
    const restored = decodeDurableBook(encoded);
    if (restored.disposition !== "decoded") throw new Error("Identity history did not replay");
    for (const state of [current.state, restored.aggregate.state]) {
      const firstResolved = resolveCanonicalPosting(state, [], sources[0]!);
      const secondResolved = resolveCanonicalPosting(state, [], sources[1]!);
      identitiesUnambiguous &&= profile === undefined ? firstResolved === undefined
        : firstResolved?.id === first.journal.postings[0]!.id;
      identitiesUnambiguous &&= secondResolved?.id === second.journal.postings[0]!.id &&
        first.journal.postings[0]!.id !== second.journal.postings[0]!.id;
    }
    const retry = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, sourceCommand);
    sameCanonicalHash &&= retry.result.disposition === "replayed" &&
      JSON.stringify(retry.result.resultHash) === JSON.stringify(original.resultHash) &&
      encodeDurableBook({ state: retry.state, protocol: retry.protocol }) === encoded;
  }
  return admit({ identities_unambiguous: identitiesUnambiguous, same_canonical_hash: sameCanonicalHash });
};

const I04: Runner = () => reject(diagnosticOf(correctionResult(false)));
const I05: Runner = () => {
  const fresh = freshState();
  const result = executeBookCommand(fresh.state, fresh.protocol, sealCommand({ ...activationCommand("design-unresolved"), lotOperations: [{
    type: "dispose", holdingIds: [], requestedQuantity: ExactRational.of(1n, 1n), selection: { method: "fifo" }, derivation: derivation(), identities: [], journalPostingId: postingId("design-unused"),
  }] }));
  return reject(diagnosticOf(result));
};

const I06: Runner = async () => {
  const forbidden = [/\bfetch\s*\(/, /\bDate\.now\s*\(/, /\bMath\.random\s*\(/, /\bBun\.(?:file|write|serve|connect)\s*\(/, /\bprocess\.env\b/, /\bnode:(?:fs|net|http|https|dns|crypto)\b/];
  const glob = new Bun.Glob("packages/kernel/src/*.ts");
  let impure = false;
  for await (const path of glob.scan({ cwd: ".", absolute: false })) {
    const source = await Bun.file(path).text();
    // Only deterministic hashing may use native crypto; randomness and I/O remain forbidden.
    const checked = path === "packages/kernel/src/canonical.ts"
      ? source.replace(/^import \{ createHash \} from "node:crypto";\n/, "") : source;
    if (forbidden.some((pattern) => pattern.test(checked))) impure = true;
  }
  if (impure) throw new Error("Semantic core contains an ambient dependency");
  return reject("impure_core_dependency");
};

const I10: Runner = () => {
  const booked = Object.freeze({ transactionPrice: ExactRational.of(1n, 1n), basis: ExactRational.of(2n, 1n), bookValue: ExactRational.of(3n, 1n) });
  const eur = commodityId("EUR");
  valueWithObservation({ canonicalNumber: ExactRational.of(1n, 1n), commodityId: IDS.usd }, {
    id: priceObservationId("design-i10-price"), effectiveAt: instant("2026-01-16T00:00:00Z"), observedAt: instant("2026-01-16T00:00:00Z"),
    kind: "marketQuote", baseCommodityId: IDS.usd, quoteCommodityId: eur, rate: ExactRational.of(2n, 1n), evidenceId: evidenceId("design-i10"),
  }, instant("2026-01-17T00:00:00Z"), false);
  if (!booked.bookValue.equals(ExactRational.of(3n, 1n))) throw new Error("Valuation mutated booking");
  return reject("valuation_mutates_booking");
};

const I14: Runner = () => {
  const value = journal("design-i14");
  if (hashCanonical(canonicalJournalValue(value)).digest !== hashCanonical(canonicalJournalValue({ ...value, postings: [...value.postings].reverse() })).digest) throw new Error("Canonical hash drifted with input order");
  return reject("noncanonical_ordering");
};

const I15: Runner = () => {
  const fresh = freshState();
  const prepared = evaluateBookCommand(fresh.state, fresh.protocol, activationCommand("design-prepared"));
  if (prepared.disposition !== "ready") throw new Error("Intent did not prepare");
  const competing = executeBookCommand(fresh.state, fresh.protocol, activationCommand("design-competing"));
  return reject(diagnosticOf(commitBookIntent(competing.state, competing.protocol, prepared.intent)));
};

const I19: Runner = () => {
  const fresh = freshState();
  const command = activationCommand("design-replay");
  const first = executeBookCommand(fresh.state, fresh.protocol, command);
  return reject(diagnosticOf(executeBookCommand(first.state, first.protocol, { ...command, firstAccountingDate: localDate("2026-01-02") } as BookCommand)));
};

/** A book that selected the chain-head state commitment, activated and holding `journals` journals. */
function chainHeadBook(journals: number): AtomicBookCommit {
  const fresh = freshState(), base = fresh.state;
  const initial = createBookState(base.identity, base.periods, base.admissionSnapshot, base.policies,
    base.quantizationPolicies, base.accountingPolicySnapshot.policies, instant("2020-01-01T00:00:00Z"),
    undefined, CHAIN_HEAD_STATE_COMMITMENT_PROFILE);
  let current = executeBookCommand(initial, fresh.protocol, activationCommand("design-commitment-activate"));
  for (let index = 0; index < journals; index += 1) {
    current = executeBookCommand(current.state, current.protocol,
      postCommand(current.state, `design-commitment-post-${index}`, journal(`design-commitment-journal-${index}`)));
  }
  if (current.result.disposition !== "committed") throw new Error("Chain-head fixture did not commit");
  return current;
}

const V14: Runner = () => {
  const current = chainHeadBook(1);
  const state = current.state, head = state.revisions.at(-1)!;
  const plain = (hash: { readonly algorithm: string; readonly canonicalizationVersion: string; readonly digest: string }) =>
    ({ algorithm: hash.algorithm, canonicalizationVersion: hash.canonicalizationVersion, digest: hash.digest });
  const specification = hashCanonical({ type: "BookStateChainHeadCommitment", profile: "chain-head-state-commitment-v1",
    identityHash: plain(state.financialIdentityHash), status: state.status, bookRevision: state.bookRevision,
    latestPostingSequence: state.latestPostingSequence, configurationRevision: state.configurationRevision,
    configurationHash: plain(state.configurationHash), activeConfigurationSnapshotHash: plain(state.activeConfigurationSnapshot.contentHash),
    openingBoundaryHash: plain(state.openingBoundary!.contentHash), revisionCount: BigInt(state.revisions.length),
    revisionChainHash: plain(head.chainHash) });
  const restored = decodeDurableBook(encodeDurableBook({ state, protocol: current.protocol }));
  const fresh = freshState();
  const legacy = executeBookCommand(fresh.state, fresh.protocol, activationCommand());
  return admit({
    commitment_matches_specification: state.contentHash.digest === specification.digest && hashBookState(state).digest === specification.digest,
    restored_state_equal: restored.disposition === "decoded" && restored.aggregate.state.contentHash.digest === state.contentHash.digest &&
      JSON.stringify(encodeDurableBook(restored.aggregate)) === JSON.stringify(encodeDurableBook({ state, protocol: current.protocol })),
    legacy_hash_unchanged: legacy.state.contentHash.digest === "6ce770fae170f2d0f1c8e5fb328396aa807597083692609d020d0cb7530f8ce2" &&
      legacy.state.activeConfigurationSnapshot.stateCommitmentProfile === undefined,
  });
};

const I25: Runner = () => {
  const current = chainHeadBook(2);
  const damagedJournals = current.state.journals.map((item, index) => index === 0
    ? { ...item, journal: { ...item.journal, narration: "journal list no longer equals the revision effects" } } : item);
  const { contentHash: _sealed, ...body } = { ...current.state, journals: damagedJournals };
  const resealed = { ...body, contentHash: hashBookState(body) } as BookState;
  if (resealed.contentHash.digest !== current.state.contentHash.digest) throw new Error("The commitment must not depend on the journal list");
  const diagnostics = validateBookState(resealed);
  if (diagnostics.length === 0) throw new Error("Damaged materialization was admitted");
  if (decodeDurableBook(encodeDurableBook({ state: resealed, protocol: current.protocol })).disposition !== "rejected") throw new Error("Damaged history decoded");
  return reject(diagnostics[0]!.code);
};

const I20: Runner = () => {
  const state = activate().state;
  const damaged = { ...state, contentHash: hashCanonical({ damaged: true }) };
  const encoded = encodeDurableBook({ state: damaged, protocol: freshState().protocol });
  if (decodeDurableBook(encoded).disposition !== "rejected") throw new Error("Damaged history decoded");
  return reject("ordered_history_violation");
};

const I21: Runner = () => {
  const result = V10();
  if (result instanceof Promise) throw new Error("Unexpected async close case");
  if (result.facts.current_close_unambiguous !== true) throw new Error("Dependent close remained current");
  return reject("dependent_close_not_current");
};

const I22: Runner = () => {
  const active = activate();
  const rebuilt = rebuildAccountBalanceProjection(active.state.revisions);
  if (rebuilt.disposition !== "rebuilt") throw new Error("Projection did not rebuild");
  const diagnostics = verifyProjectionCheckpoint(active.state.revisions, { ...rebuilt.checkpoint, contentHash: hashCanonical({ damaged: true }) });
  if (diagnostics.length === 0) throw new Error("Projection divergence was admitted");
  return reject(diagnostics[0]!.code);
};

const I23: Runner = () => {
  const value = journal("design-i23");
  const axis = dimensionId("design-required-axis");
  const snapshot: JournalAdmissionSnapshot = { ...freshState().state.admissionSnapshot,
    dimensions: [{ id: axis, bookId: IDS.book, code: "AXIS", name: "Axis", openedOn: localDate("2020-01-01") }], dimensionMembers: [], requiredDimensionIds: [axis] };
  const result = admitJournal(snapshot, value);
  if (result.disposition !== "rejected") throw new Error("Missing dimension was admitted");
  return reject(result.diagnostics[0]!.code);
};

const I24: Runner = () => {
  const base = freshState().state.admissionSnapshot;
  const duplicate = { ...base, accounts: [base.accounts[0]!, { ...base.accounts[1]!, id: base.accounts[0]!.id }] };
  const result = admitJournal(duplicate, journal("design-i24"));
  if (result.disposition !== "rejected") throw new Error("Duplicate identity was admitted");
  return reject(result.diagnostics[0]!.code);
};

export const DESIGN_CASE_EXECUTORS: Readonly<Record<string, Runner>> = Object.freeze({
  "V01-balanced-journal": V01,
  "V02-exact-correction": V02,
  "V03-resolved-deterministic-command": V03,
  "V04-lot-disposal": V04,
  "V05-account-and-chart": V05,
  "V06-price-separation": V06,
  "V07-order-equivalence": V07,
  "V08-atomic-command": V08,
  "V09-empty-activation": V09,
  "V10-close-reopen": V10,
  "V11-projection-rebuild": V11,
  "V12-typed-dimensions": V12,
  "V13-canonical-identity": V13,
  "V14-chain-head-state-commitment": V14,
  "I01-invalid-number": () => { try { ExactRational.of(1n, 0n); } catch { return reject("invalid_exact_number"); } throw new Error("Invalid rational admitted"); },
  "I02-type-substitution": () => reject(invalidJournal("monetary_type_mismatch")),
  "I03-imbalanced-journal": () => reject(invalidJournal("journal_imbalance")),
  "I04-invalid-correction": I04,
  "I05-unresolved-input": I05,
  "I06-nondeterministic-core": I06,
  "I07-lot-identity-alias": () => { const result = allocateLots([validHolding, validHolding], [validLot], ExactRational.of(1n, 1n), { method: "fifo" }, derivation(), []); if (result.disposition !== "rejected") throw new Error("Aliased lot holding admitted"); return reject(result.diagnostics[0]!.code); },
  "I08-lot-overallocation": () => { const result = lotAllocation(ExactRational.of(3n, 1n)); if (result.disposition !== "rejected") throw new Error("Over-allocation admitted"); return reject(result.diagnostics[0]!.code); },
  "I09-transfer-policy-missing": () => {
    const result = transferLots([validHolding], [], [validLot], ExactRational.of(1n, 1n), { method: "fifo" }, [],
      instant("2026-01-15T00:00:00Z"), IDS.revenue, derivation(),
      [{ holdingId: validHolding.id, allocationId: lotAllocationId("design-transfer-allocation") }],
      [{ sourceHoldingId: validHolding.id, destinationHoldingId: lotHoldingId("design-transfer-destination") }]);
    if (result.disposition !== "rejected") throw new Error("Boundary-free transfer was admitted");
    return reject(result.diagnostics[0]!.code);
  },
  "I10-market-rewrites-booking": I10,
  "I11-time-conflation": () => { const fresh = freshState(); const command = sealCommand({ ...activationCommand("design-time"), completedAt: instant("2025-12-31T00:00:00Z") }); return reject(diagnosticOf(executeBookCommand(fresh.state, fresh.protocol, command))); },
  "I12-invalid-chart": () => { const base = freshState().state.admissionSnapshot; const result = admitJournal({ ...base, accounts: [base.accounts[0]!, { ...base.accounts[1]!, code: base.accounts[0]!.code }] }, journal("design-invalid-chart")); if (result.disposition !== "rejected") throw new Error("Invalid chart admitted"); return reject(result.diagnostics[0]!.code); },
  "I13-invalid-journal-structure": () => reject(invalidJournal("invalid_journal_structure")),
  "I14-order-hash-drift": I14,
  "I15-partial-canonical-commit": I15,
  "I16-financial-identity-mutation": () => { const active = activate(); const damaged = { ...active.state, identity: { ...active.state.identity, ownerId: "changed-owner" as never } }; return reject(diagnosticOf(executeBookCommand(damaged, active.protocol, postCommand(active.state, "design-mutated", journal("design-mutated-journal"))))); },
  "I17-fabricated-opening": () => { const fresh = freshState(); const command = sealCommand({ ...activationCommand("design-fabricated"), opening: resolved(journal("design-fabricated-opening", "2026-01-01", "opening")) }); return reject(diagnosticOf(executeBookCommand(fresh.state, fresh.protocol, command))); },
  "I18-period-ambiguity": () => { const overlap = [{ ...periods[0]! }, { ...periods[1]!, startsOn: localDate("2026-01-15") }]; const fresh = freshState(overlap); return reject(diagnosticOf(executeBookCommand(fresh.state, fresh.protocol, activationCommand("design-overlap")))); },
  "I19-command-replay-conflict": I19,
  "I20-history-sequence-error": I20,
  "I21-downstream-close-ambiguity": I21,
  "I22-projection-divergence": I22,
  "I23-invalid-dimension-selection": I23,
  "I24-canonical-identity-conflict": I24,
  "I25-chain-head-materialization-divergence": I25,
});

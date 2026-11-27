/**
 * Deterministic books and tampered copies of them, observed through a kernel module that is passed in.
 *
 * `validation-equivalence.test.ts` runs them against the working tree and compares every observable with a
 * golden table. The table was produced by this same code run against the kernel as it stood before the
 * validators were rewritten as single passes: commit e5e67f34 for books without the state commitment
 * profile and commit d94af529 for books with it. So a match means those validators, the durable
 * encoding and the state hashes still say exactly what they said.
 */
import type * as KernelModule from "../src/index.ts";

export type Kernel = typeof KernelModule;

function makeRng(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function setup(K: Kernel) {
  const bid = K.bookId("book-main");
  const usd = K.commodityId("USD");
  const owner = K.identifier<"BookOwner">("owner-main");
  const actor = K.actorId("actor-main");
  const calendar = K.fiscalCalendarId("calendar-main");
  const codes = ["1000", "3000", "4000", "5000"];
  const accounts = codes.map((code) => K.accountId(code));
  const identity = Object.freeze({
    bookId: bid,
    code: "VAL",
    ownerId: owner,
    ownerKind: "legalEntity" as const,
    kind: "operational" as const,
    functionalCommodityId: usd,
    primaryBasis: "accrual" as const,
    fiscalCalendarId: calendar,
    accountingTimeZone: "America/Denver",
  });
  const periods = daysInMonth.map((count, index) => {
    const month = String(index + 1).padStart(2, "0");
    return Object.freeze({
      id: K.fiscalPeriodId(`period-2026-${month}`),
      calendarId: calendar,
      fiscalYear: 2026n,
      sequence: BigInt(index + 1),
      label: `2026-${month}`,
      kind: "regular" as const,
      startsOn: K.localDate(`2026-${month}-01`),
      endsOn: K.localDate(`2026-${month}-${String(count).padStart(2, "0")}`),
    });
  });
  const policy = Object.freeze({
    id: K.policyId("policy-main"),
    bookId: bid,
    version: K.semanticVersion("1.0.0"),
    validFrom: K.instant("2020-01-01T00:00:00Z"),
    lotSelection: "specificIdentification" as const,
    scope: "legalEntity" as const,
    scopeKey: owner,
    requiredDimensionIds: Object.freeze([]),
    implementationVersion: K.semanticVersion("1.0.0"),
    capability: Object.freeze({
      id: K.policyCapabilityId("capability-specific-legal-entity"),
      method: "specificIdentification" as const,
      scope: "legalEntity" as const,
      status: "supported" as const,
      implementationVersion: K.semanticVersion("1.0.0"),
      verificationEvidenceIds: Object.freeze([K.evidenceId("kernel-fixture-v04")]),
    }),
  });
  const quantization = Object.freeze({
    id: K.quantizationPolicyId("quantization-usd"),
    version: K.semanticVersion("1.0.0"),
    bookId: bid,
    functionalCommodityId: usd,
    validFrom: K.localDate("2020-01-01"),
    targetScale: 2n,
    roundingMode: "halfEven" as const,
    roundingAccountId: accounts[0]!,
  });
  const role = (code: string) => (code === "1000" || code === "5000" ? "asset" : code === "3000" ? "equity" : "income");
  const admission = Object.freeze({
    bookId: bid,
    functionalCommodityId: usd,
    accounts: Object.freeze(
      codes.map((code, index) =>
        Object.freeze({
          id: accounts[index]!,
          bookId: bid,
          code,
          name: code,
          role: role(code) as "asset",
          normalSide: (code === "1000" || code === "5000" ? "debit" : "credit") as "debit",
          postingAllowed: true,
          openedOn: K.localDate("2020-01-01"),
          allowedCommodityIds: Object.freeze([]),
        }),
      ),
    ),
    dimensions: Object.freeze([]),
    dimensionMembers: Object.freeze([]),
    requiredDimensionIds: Object.freeze([]),
  });
  return { K, bid, usd, owner, actor, accounts, identity, periods, policy, quantization, admission };
}
type Setup = ReturnType<typeof setup>;

function stamp(S: Setup, seconds: number) {
  const ms = Date.parse("2026-01-01T00:00:00Z") + seconds * 1000;
  return {
    issuedAt: S.K.instant(new Date(ms).toISOString()),
    completedAt: S.K.instant(new Date(ms + 1).toISOString()),
    committedAt: S.K.instant(new Date(ms + 2).toISOString()),
  };
}

function core(S: Setup, id: string, revision: bigint, seconds: number) {
  return {
    id: S.K.commandId(id),
    protocolVersion: S.K.semanticVersion("1.0.0"),
    bookId: S.bid,
    expectedBookRevision: revision,
    ...stamp(S, seconds),
    actorId: S.actor,
  };
}

function journalFor(S: Setup, id: string, date: string, debit: number, credit: number, cents: bigint, kind: "ordinary" | "reversing" = "ordinary") {
  const { K } = S;
  const postings = [
    { account: S.accounts[debit]!, value: cents },
    { account: S.accounts[credit]!, value: -cents },
  ].map((line, ordinal) => ({
    id: K.postingId(`${id}-${ordinal}`),
    ordinal: BigInt(ordinal),
    accountId: line.account,
    units: { canonicalNumber: K.ExactRational.of(line.value, 100n), commodityId: S.usd },
    bookValue: { amount: K.ExactDecimal.of(line.value, 2n), functionalCommodityId: S.usd },
    dimensionMemberIds: [],
  }));
  return {
    id: K.journalId(id),
    kind,
    bookId: S.bid,
    functionalCommodityId: S.usd,
    economicAt: K.instant(`${date}T12:00:00Z`),
    accountingDate: K.localDate(date),
    recordedAt: K.instant(`${date}T13:00:00Z`),
    narration: `Journal ${id}`,
    postings,
  } as any;
}

function resolve(S: Setup, journal: any, lineage?: { original: string; hash: any }) {
  const { K } = S;
  const result = K.resolveJournal(
    journal,
    [S.policy],
    S.owner,
    S.quantization,
    journal.postings.map((posting: any) => posting.bookValue.amount.toRational()),
    [],
  );
  if (Array.isArray(result)) throw new Error(result.map((item: any) => item.message).join("; "));
  if (lineage === undefined) return result as any;
  return Object.freeze({
    ...(result as object),
    derivations: Object.freeze([
      Object.freeze({
        id: K.derivationId("scenario-correction"),
        policyId: S.policy.id,
        policyVersion: S.policy.version,
        algorithmVersion: K.semanticVersion("1.0.0"),
        inputHash: K.hashCanonical({ original: lineage.original }),
        actorId: S.actor,
        state: "approved" as const,
        recordedAt: K.instant("2026-01-01T00:00:00Z"),
        evidence: Object.freeze([
          Object.freeze({
            id: K.evidenceId("scenario-evidence"),
            sourceSystem: "scenario",
            sourceRecordId: lineage.original,
            observedAt: K.instant("2026-01-01T00:00:00Z"),
            contentHash: lineage.hash,
          }),
        ]),
      }),
    ]),
  }) as any;
}

function render(diagnostics: readonly { code: string; path: string; message: string; requirementIds: readonly string[] }[]): string {
  return JSON.stringify(diagnostics.map((item) => [item.code, item.path, item.message, [...item.requirementIds]]));
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** The names of the tampered copies each scenario checks. */
export const TAMPERS = [
  "swapRevisions",
  "dropRevision",
  "duplicateRevision",
  "duplicateCommandId",
  "bumpRevisionNumber",
  "hugeRevisionNumber",
  "zeroRevisionNumber",
  "dropActivationFromRevisions",
  "journalSequence",
  "swapJournals",
  "dropJournal",
  "dropCorrection",
  "dropTransition",
  "dropClose",
  "dropRetained",
  "duplicateRetained",
  "swapRetained",
  "retainedObserved",
  "retainedIntentHash",
  "retainedOutcomeFlip",
  "retainedForeign",
  "emptyProtocol",
  "bothReordered",
] as const;

/**
 * Run one scenario of `steps` random commands (postings, reversals, closes, reopens, configuration
 * replacements, duplicates and stale commands that are rejected and retained) and observe it.
 * The result maps an observable to a SHA-256 of its text: dispositions and hashes after every step,
 * the durable encoding of the final book, the diagnostics of both validators on it, and on two
 * tampered copies of each kind.
 */
export function observeScenario(K: Kernel, seed: number, steps: number, commitment = false): Record<string, string> {
  const S = setup(K);
  const rng = makeRng(seed);
  let state: any = K.createBookState(
    S.identity,
    S.periods,
    S.admission as any,
    [S.policy],
    [S.quantization],
    [],
    K.instant("2020-01-01T00:00:00Z"),
    undefined,
    commitment ? K.CHAIN_HEAD_STATE_COMMITMENT_PROFILE : undefined,
  );
  let protocol: any = K.createBookProtocolState();
  const observed: string[] = [];
  let clock = 0;
  const step = (command: any) => {
    const next = K.executeBookCommand(state, protocol, command);
    observed.push(
      [
        command.type,
        next.result.disposition,
        next.result.diagnostics.map((item: any) => item.code).join(","),
        next.result.resultHash.digest,
        next.state.contentHash.digest,
        next.state.bookRevision,
      ].join(":"),
    );
    state = next.state;
    protocol = next.protocol;
  };
  step(K.sealCommand({ ...core(S, "activate", 0n, clock++), type: "activateBook", mode: "newZeroBalance", boundaryId: K.openingBoundaryId("opening-main"), firstAccountingDate: K.localDate("2026-01-01") } as any));
  let counter = 0;
  for (let index = 0; index < steps; index += 1) {
    clock += 1 + Math.floor(rng() * 3);
    const roll = rng();
    const month = 1 + Math.floor(rng() * 12);
    const date = `2026-${String(month).padStart(2, "0")}-${String(1 + Math.floor(rng() * 27)).padStart(2, "0")}`;
    counter += 1;
    if (roll < 0.62) {
      const debit = Math.floor(rng() * 2) === 0 ? 0 : 3;
      const journal = journalFor(S, `j${counter}`, date, debit, 2, BigInt(100 + Math.floor(rng() * 90000)));
      step(K.sealCommand({ ...core(S, `post-${counter}`, state.bookRevision, clock), type: "postJournal", resolved: resolve(S, journal) } as any));
    } else if (roll < 0.7 && state.journals.length > 0) {
      const original = state.journals[Math.floor(rng() * state.journals.length)];
      const was = original.journal;
      const shape = journalFor(S, `r${counter}`, was.accountingDate, 0, 2, 100n, "reversing");
      const negated = {
        ...shape,
        postings: was.postings.map((posting: any, position: number) => ({
          id: K.postingId(`r${counter}-${position}`),
          ordinal: posting.ordinal,
          accountId: posting.accountId,
          units: { canonicalNumber: posting.units.canonicalNumber.negate(), commodityId: posting.units.commodityId },
          bookValue: { amount: posting.bookValue.amount.negate(), functionalCommodityId: posting.bookValue.functionalCommodityId },
          dimensionMemberIds: [],
        })),
      };
      step(
        K.sealCommand({
          ...core(S, `correct-${counter}`, state.bookRevision, clock),
          type: "correctJournal",
          correctionKind: "reversal",
          originalJournalId: was.id,
          resolved: resolve(S, negated, { original: was.id, hash: original.canonicalHash }),
        } as any),
      );
    } else if (roll < 0.78) {
      const period = 1 + Math.floor(rng() * 12);
      step(
        K.sealCommand({
          ...core(S, `close-${counter}`, state.bookRevision, clock),
          type: "closePeriod",
          periodId: K.fiscalPeriodId(`period-2026-${String(period).padStart(2, "0")}`),
          closePackageId: K.closePackageId(`close-${counter}`),
          reason: "scenario",
          reportPopulationHash: K.hashCanonical({ population: BigInt(counter) }),
          reportingPolicySnapshotHash: K.hashCanonical({ policy: BigInt(counter) }),
        } as any),
      );
    } else if (roll < 0.85) {
      const period = 1 + Math.floor(rng() * 12);
      step(
        K.sealCommand({
          ...core(S, `reopen-${counter}`, state.bookRevision, clock),
          type: "reopenPeriod",
          periodId: K.fiscalPeriodId(`period-2026-${String(period).padStart(2, "0")}`),
          reason: "scenario",
        } as any),
      );
    } else if (roll < 0.89) {
      step(
        K.sealCommand({
          ...core(S, `config-${counter}`, state.bookRevision, clock),
          type: "replaceConfiguration",
          effectiveOn: K.localDate("2027-01-01"),
          expectedConfigurationRevision: state.configurationRevision,
          periods: state.periods,
          admissionSnapshot: state.admissionSnapshot,
          policies: [S.policy],
          quantizationPolicies: [S.quantization],
          accountingPolicies: state.accountingPolicySnapshot.policies,
        } as any),
      );
    } else if (roll < 0.94 && state.journals.length > 0) {
      const duplicate = state.journals[Math.floor(rng() * state.journals.length)].journal;
      step(K.sealCommand({ ...core(S, `dup-${counter}`, state.bookRevision, clock), type: "postJournal", resolved: resolve(S, journalFor(S, duplicate.id, date, 0, 2, 500n)) } as any));
    } else {
      step(K.sealCommand({ ...core(S, `stale-${counter}`, state.bookRevision + 5n, clock), type: "postJournal", resolved: resolve(S, journalFor(S, `stale${counter}`, date, 0, 2, 700n)) } as any));
    }
  }
  const out: Record<string, string> = {
    steps: sha256(observed.join("\n")),
    encoded: sha256(K.encodeDurableBook({ state, protocol } as any)),
    stateDiagnostics: sha256(render(K.validateBookState(state))),
    protocolDiagnostics: sha256(render(K.validateBookProtocol(state, protocol))),
  };
  const draw = makeRng(seed * 31 + 7);
  const pick = (count: number) => Math.floor(draw() * count);
  const revisions: any[] = [...state.revisions];
  const journals: any[] = [...state.journals];
  const retained: any[] = [...protocol.retainedResults];
  const swapped = <T>(list: T[]) => {
    const copy = [...list];
    const a = pick(list.length || 1);
    const b = pick(list.length || 1);
    [copy[a], copy[b]] = [copy[b]!, copy[a]!];
    return copy;
  };
  const edited = <T>(list: T[], change: (item: T) => T) => {
    const copy = [...list];
    const at = pick(list.length || 1);
    if (copy.length > 0) copy[at] = change(copy[at]!);
    return copy;
  };
  const tampers: Record<(typeof TAMPERS)[number], () => { state: any; protocol: any }> = {
    swapRevisions: () => ({ state: { ...state, revisions: swapped(revisions) }, protocol }),
    dropRevision: () => ({ state: { ...state, revisions: revisions.filter((_, position) => position !== pick(revisions.length)) }, protocol }),
    duplicateRevision: () => {
      const copy = [...revisions];
      const at = pick(copy.length);
      copy.splice(at, 0, revisions[at]);
      return { state: { ...state, revisions: copy }, protocol };
    },
    duplicateCommandId: () => ({
      state: { ...state, revisions: edited(revisions, (item) => ({ ...item, command: { ...item.command, id: revisions[pick(revisions.length)].command.id } })) },
      protocol,
    }),
    bumpRevisionNumber: () => ({ state: { ...state, revisions: edited(revisions, (item) => ({ ...item, bookRevision: item.bookRevision + 1n })) }, protocol }),
    hugeRevisionNumber: () => ({ state: { ...state, revisions: edited(revisions, (item) => ({ ...item, bookRevision: 10_000n })) }, protocol }),
    zeroRevisionNumber: () => ({ state: { ...state, revisions: edited(revisions, (item) => ({ ...item, bookRevision: 0n })) }, protocol }),
    dropActivationFromRevisions: () => ({ state: { ...state, revisions: revisions.map((item) => ({ ...item, effects: item.effects.filter((effect: any) => effect.type !== "activation") })) }, protocol }),
    journalSequence: () => ({ state: { ...state, journals: edited(journals, (item) => ({ ...item, postingSequence: item.postingSequence + 1n })) }, protocol }),
    swapJournals: () => ({ state: { ...state, journals: swapped(journals) }, protocol }),
    dropJournal: () => ({ state: { ...state, journals: journals.filter((_, position) => position !== pick(journals.length || 1)) }, protocol }),
    dropCorrection: () => ({ state: { ...state, corrections: state.corrections.slice(1) }, protocol }),
    dropTransition: () => ({ state: { ...state, periodTransitions: state.periodTransitions.slice(1) }, protocol }),
    dropClose: () => ({ state: { ...state, closePackages: state.closePackages.slice(1) }, protocol }),
    dropRetained: () => ({ state, protocol: { retainedResults: retained.filter((_, position) => position !== pick(retained.length)) } }),
    duplicateRetained: () => {
      const copy = [...retained];
      const at = pick(copy.length);
      copy.splice(at, 0, retained[at]);
      return { state, protocol: { retainedResults: copy } };
    },
    swapRetained: () => ({ state, protocol: { retainedResults: swapped(retained) } }),
    retainedObserved: () => ({ state, protocol: { retainedResults: edited(retained, (item) => ({ ...item, observedBookRevision: item.observedBookRevision + 1n })) } }),
    retainedIntentHash: () => ({ state, protocol: { retainedResults: edited(retained, (item) => ({ ...item, commitIntentHash: K.hashCanonical({ other: 1n }) })) } }),
    retainedOutcomeFlip: () => ({ state, protocol: { retainedResults: edited(retained, (item) => ({ ...item, outcome: item.outcome === "committed" ? "rejected" : "committed" })) } }),
    retainedForeign: () => ({
      state,
      protocol: { retainedResults: edited(retained, (item) => ({ ...item, commandId: K.commandId("foreign"), command: { ...item.command, id: K.commandId("foreign") } })) },
    }),
    emptyProtocol: () => ({ state, protocol: { retainedResults: [] } }),
    bothReordered: () => ({ state: { ...state, revisions: [...revisions].reverse() }, protocol: { retainedResults: [...retained].reverse() } }),
  };
  const seen = (run: () => readonly { code: string; path: string; message: string; requirementIds: readonly string[] }[]) => {
    try {
      return sha256(render(run()));
    } catch (error) {
      return `threw ${(error as Error).constructor.name}`;
    }
  };
  for (const name of TAMPERS) {
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const tampered = tampers[name]();
      out[`${name}#${repeat}:state`] = seen(() => K.validateBookState(tampered.state));
      out[`${name}#${repeat}:protocol`] = seen(() => K.validateBookProtocol(tampered.state, tampered.protocol));
    }
  }
  return out;
}

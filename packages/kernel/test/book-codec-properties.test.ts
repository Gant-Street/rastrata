import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  ACCOUNTING_LIMITS,
  ExactDecimal,
  ExactRational,
  IdentityError,
  admitJournal,
  calculateCurrencyRemeasurement,
  canonicalEncode,
  commandId,
  compareInstants,
  createBookProtocolState,
  createBookState,
  decodeDurableBook,
  derivationId,
  determineTax,
  effectKey,
  encodeDurableBook,
  evaluateBookCommand,
  evidenceId,
  executeBookCommand,
  hashBookState,
  hashCanonical,
  hashCanonicalSequenceField,
  identifier,
  instant,
  journalId,
  localDate,
  policyId,
  postingId,
  prepareInventoryOwnershipEffect,
  rebuildAccountBalanceProjection,
  sealCommand,
  semanticVersion,
  validateBookState,
  type AccountId,
  type AccountingPolicy,
  type BookCommand,
  type BookProtocolState,
  type BookState,
  type CurrencyPolicy,
  type Instant,
  type JournalTransaction,
  type MonetaryClassificationPolicy,
  type TaxPolicy,
} from "../src/index.ts";
import {
  account,
  accountingDerivation,
  accountingEvidenceId,
  capability,
  classificationRule,
  taxComponent,
  taxRequest,
  taxableLine,
} from "./accounting-fixtures.ts";
import { IDS, closePackageId, freshState, journal, periods, policy, quantizationPolicy, reportHash, reportPolicyHash, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

describe("Lean-discovered kernel defect regressions", () => {
  test("determineTax sums postings when a later line's account order is smaller than an earlier line's", () => {
    const fiveComponentPolicy: TaxPolicy = Object.freeze({
      id: policyId("tax-five"),
      version: semanticVersion("1.0.0"),
      bookId: IDS.book,
      validFrom: instant("2020-01-01T00:00:00Z"),
      algorithmVersion: semanticVersion("1.0.0"),
      quantizationPolicy,
      capability: capability("taxDetermination", "compound"),
      kind: "taxDetermination" as const,
      taxCode: "FIVE",
      jurisdiction: "US",
      roundingLevel: "lineLevel" as const,
      components: Object.freeze([
        taxComponent("c1", { compoundOrdinal: 1n, recoverableAccountId: account("tax-rec-1") }),
        taxComponent("c2", { compoundOrdinal: 2n, recoverableAccountId: account("tax-rec-2") }),
        taxComponent("c3", { compoundOrdinal: 3n, recoverableAccountId: account("tax-rec-3") }),
        taxComponent("c4", { compoundOrdinal: 4n, recoverableAccountId: account("tax-rec-4") }),
        taxComponent("c5", { compoundOrdinal: 5n, recoverableAccountId: account("tax-rec-5") }),
      ]),
    });
    const oneComponentPolicy: TaxPolicy = Object.freeze({
      id: policyId("tax-one"),
      version: semanticVersion("1.0.0"),
      bookId: IDS.book,
      validFrom: instant("2020-01-01T00:00:00Z"),
      algorithmVersion: semanticVersion("1.0.0"),
      quantizationPolicy,
      capability: capability("taxDetermination", "compound"),
      kind: "taxDetermination" as const,
      taxCode: "ONE",
      jurisdiction: "US",
      roundingLevel: "lineLevel" as const,
      components: Object.freeze([
        taxComponent("c-only", { recoverableAccountId: account("tax-rec-1") }),
      ]),
    });
    const result = determineTax(
      [fiveComponentPolicy, oneComponentPolicy],
      IDS.book,
      IDS.usd,
      taxRequest("tax-order-overwrite", [
        taxableLine("line-1", {
          policyId: fiveComponentPolicy.id,
          statedAmount: ExactRational.of(100n, 1n),
          sourceAccountId: account("expense-a"),
          payableAccountId: account("ap-shared"),
        }),
        taxableLine("line-2", {
          policyId: oneComponentPolicy.id,
          statedAmount: ExactRational.of(100n, 1n),
          sourceAccountId: account("expense-b"),
          payableAccountId: account("ap-shared"),
        }),
      ]),
    );
    expect(result.disposition).toBe("draft");
    if (result.disposition === "draft") {
      const postings = result.draft.journals[0]!.postings;
      const sum = postings.reduce((acc, p) => acc.add(p.exactBookValue), ExactRational.zero());
      expect(sum.isZero()).toBeTrue();
      const ap = postings.find((p) => p.accountId === account("ap-shared"));
      expect(ap?.exactBookValue.equals(ExactRational.of(-260n, 1n))).toBeTrue();
    }

    // Reverse-charge where non-recoverable account equals liability account (same line, smaller order second).
    const reverseChargePolicy: TaxPolicy = Object.freeze({
      id: policyId("tax-rc"),
      version: semanticVersion("1.0.0"),
      bookId: IDS.book,
      validFrom: instant("2020-01-01T00:00:00Z"),
      algorithmVersion: semanticVersion("1.0.0"),
      quantizationPolicy,
      capability: capability("taxDetermination", "compound"),
      kind: "taxDetermination" as const,
      taxCode: "RC",
      jurisdiction: "US",
      roundingLevel: "lineLevel" as const,
      components: Object.freeze([
        taxComponent("rc1", {
          treatment: "reverseCharge",
          recoverability: "nonRecoverable",
          recoverableShare: ExactRational.zero(),
          nonRecoverableAccountId: account("rc-shared"),
          liabilityAccountId: account("rc-shared"),
        }),
      ]),
    });
    const rcResult = determineTax(
      [reverseChargePolicy],
      IDS.book,
      IDS.usd,
      taxRequest("tax-rc-same-acct", [
        taxableLine("rc-line", { policyId: reverseChargePolicy.id }),
      ]),
    );
    expect(rcResult.disposition).toBe("draft");
    if (rcResult.disposition === "draft") {
      const sum = rcResult.draft.journals[0]!.postings.reduce((acc, p) => acc.add(p.exactBookValue), ExactRational.zero());
      expect(sum.isZero()).toBeTrue();
    }
  });

  test("admitJournal does not throw on Object.prototype property names as posting IDs", () => {
    const fresh = freshState();
    const snapshot = { ...fresh.state.admissionSnapshot, requiredDimensionIdsByPosting: {} };
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      const base = journal(`proto-${name}`);
      const patched: JournalTransaction = Object.freeze({
        ...base,
        postings: Object.freeze([
          Object.freeze({ ...base.postings[0]!, id: postingId(name) }),
          base.postings[1]!,
        ]),
      });
      const admitted = admitJournal(snapshot, patched);
      expect(admitted.disposition).toBe("admitted");
    }
  });

  test("canonical identifiers, encoding, hashing, and sequence fields reject lone UTF-16 surrogates", () => {
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdfff);
    expect(() => identifier(high)).toThrow(IdentityError);
    expect(() => identifier(low)).toThrow(IdentityError);
    expect(() => canonicalEncode(`bad${high}`)).toThrow(TypeError);
    expect(() => hashCanonical(`bad${low}`)).toThrow(TypeError);
    expect(() => canonicalEncode({ [high]: 1n })).toThrow(TypeError);
    expect(() => hashCanonical({ [low]: 1n })).toThrow(TypeError);
    expect(() => hashCanonicalSequenceField({}, high, 0n, [])).toThrow(TypeError);
  });

  test("compareInstants orders chronologically across offsets, arbitrary fractional seconds, and years", () => {
    // Same moment in different offsets
    expect(compareInstants(instant("2024-01-01T02:00:00+02:00"), instant("2024-01-01T00:00:00Z"))).toBe(0);
    // Offset makes textually larger instant chronologically earlier
    expect(compareInstants(instant("2024-01-01T01:00:00+02:00"), instant("2024-01-01T00:30:00Z"))).toBe(-1);
    expect(compareInstants(instant("2024-01-01T00:30:00Z"), instant("2024-01-01T01:00:00+02:00"))).toBe(1);
    // Negative offset
    expect(compareInstants(instant("2024-01-01T00:00:00-05:00"), instant("2024-01-01T04:00:00Z"))).toBe(1);
    // Fractional seconds: .0123456789Z < .1Z (breaks Date.parse) and .500Z == .5Z and .5Z > whole second
    expect(compareInstants(instant("2024-01-01T00:00:00.0123456789Z"), instant("2024-01-01T00:00:00.1Z"))).toBe(-1);
    expect(compareInstants(instant("2024-01-01T00:00:00.500Z"), instant("2024-01-01T00:00:00.5Z"))).toBe(0);
    expect(compareInstants(instant("2024-01-01T00:00:00.5Z"), instant("2024-01-01T00:00:00Z"))).toBe(1);
    // Leap years and year boundaries (Jan/Feb and post-Feb)
    expect(compareInstants(instant("2024-02-29T23:59:59Z"), instant("2024-03-01T00:00:00Z"))).toBe(-1);
    expect(compareInstants(instant("0000-01-01T00:00:00Z"), instant("9999-12-31T23:59:59Z"))).toBe(-1);
    // Defensive fallback on malformed string
    expect(compareInstants("not-an-instant" as Instant, instant("2024-01-01T00:00:00Z"))).toBe(1);

    // End-to-end policyAt with cross-offset validFrom
    const currencyPolicy: CurrencyPolicy = Object.freeze({
      id: policyId("fx-offset"),
      version: semanticVersion("1.0.0"),
      bookId: IDS.book,
      validFrom: instant("2024-01-01T01:00:00+02:00"), // 2023-12-31T23:00:00Z
      algorithmVersion: semanticVersion("1.0.0"),
      quantizationPolicy,
      capability: capability("currencyRemeasurement", "closingRate"),
      kind: "currencyRemeasurement" as const,
      reversalRequired: false,
      gainAccountId: account("fx-gain"),
      lossAccountId: account("fx-loss"),
    });
    const classPolicy: MonetaryClassificationPolicy = Object.freeze({
      id: policyId("class-offset"),
      version: semanticVersion("1.0.0"),
      bookId: IDS.book,
      validFrom: instant("2024-01-01T01:00:00+02:00"),
      algorithmVersion: semanticVersion("1.0.0"),
      quantizationPolicy,
      capability: capability("monetaryClassification", "accountClassification"),
      kind: "monetaryClassification" as const,
      rules: Object.freeze([classificationRule("r1", "eur-cash", "monetary")]),
    });
    const policies: readonly AccountingPolicy[] = [currencyPolicy, classPolicy];
    const remeasure = calculateCurrencyRemeasurement(policies, IDS.book, IDS.usd, {
      id: identifier<"RemeasurementResult">("fx-offset-result"),
      policyId: currencyPolicy.id,
      policyVersion: currencyPolicy.version,
      classificationPolicyId: classPolicy.id,
      classificationPolicyVersion: classPolicy.version,
      governedAt: instant("2024-01-01T00:30:00Z"), // later than 23:00Z despite textually smaller
      kind: "unrealized",
      classification: "monetary",
      effectiveOn: localDate("2024-01-01"),
      denominationCommodityId: identifier<"Commodity">("commodity-EUR"),
      denomination: ExactRational.of(100n, 1n),
      carryingBookValue: ExactRational.of(105n, 1n),
      valuationPath: {
        fromCommodityId: identifier<"Commodity">("commodity-EUR"),
        toCommodityId: IDS.usd,
        effectiveAt: instant("2024-01-01T00:00:00Z"),
        observedAt: instant("2024-01-01T01:00:00+02:00"), // earlier than 00:30Z
        rate: ExactRational.of(11n, 10n),
        evidenceIds: Object.freeze([accountingEvidenceId]),
      },
      positionAccountId: account("eur-cash"),
      derivation: accountingDerivation,
    });
    expect(remeasure.disposition).toBe("draft");
  });

  test("prepareInventoryOwnershipEffect rejects transfer counts whose two movements per entry exceed the validator cap", () => {
    const overCapTransfers = Math.floor(ACCOUNTING_LIMITS.maxInventoryLayers / 2) + 1;
    const dummyEntries = Array.from({ length: overCapTransfers }, () => ({}) as never);
    const result = prepareInventoryOwnershipEffect(
      {
        bookId: IDS.book,
        commandId: commandId("over-cap-transfers"),
        effectKey: effectKey("over-cap-transfers:ownership"),
        bookRevision: 2n,
        accountingDate: localDate("2026-01-15"),
        fiscalPeriodId: IDS.period1,
      },
      [],
      [{
        kind: "transfer",
        entries: dummyEntries,
        destinationInventoryPolicy: {} as never,
        destinationQuantizationPolicy: quantizationPolicy,
        destinationDimensionMemberIds: [],
      }],
    );
    expect(result.disposition).toBe("rejected");
    if (result.disposition === "rejected") {
      expect(result.diagnostics[0]?.path).toBe("inventoryOwnership.effect");
    }
  });
});

describe("stateful property-based verification of book.ts and codec.ts (fast-check)", () => {
  const SEED = 0x51a7e_b00c;

  function bootActiveBook(): { state: BookState; protocol: BookProtocolState } {
    const expense = identifier<"Account">("account-EXPENSE") as AccountId;
    const initial = createBookState(
      freshState().state.identity,
      periods,
      {
        bookId: IDS.book,
        functionalCommodityId: IDS.usd,
        accounts: [IDS.cash, IDS.revenue, expense].map((id, index) =>
          Object.freeze({
            id,
            bookId: IDS.book,
            code: `${1000 + index}`,
            name: id,
            role: id === IDS.revenue ? ("income" as const) : id === expense ? ("expense" as const) : ("asset" as const),
            normalSide: id === IDS.revenue ? ("credit" as const) : ("debit" as const),
            postingAllowed: true,
            openedOn: localDate("2020-01-01"),
            allowedCommodityIds: Object.freeze([]),
          }),
        ),
        dimensions: Object.freeze([]),
        dimensionMembers: Object.freeze([]),
        requiredDimensionIds: Object.freeze([]),
      },
      [policy],
      [quantizationPolicy],
      [],
      instant("2020-01-01T00:00:00Z"),
    );
    const protocol = createBookProtocolState();
    const active = executeBookCommand(initial, protocol, activationCommand("fc-activate"));
    expect(active.result.disposition).toBe("committed");
    return { state: active.state, protocol: active.protocol };
  }

  function makeTimes(day: string, offsetSeconds: number) {
    const base = Date.parse(`${day}T12:00:00Z`) + offsetSeconds * 1000;
    return {
      issuedAt: instant(new Date(base).toISOString()),
      completedAt: instant(new Date(base + 1000).toISOString()),
      committedAt: instant(new Date(base + 2000).toISOString()),
    };
  }

  function buildPostCommand(
    state: BookState,
    id: string,
    cents: bigint,
    day: string,
    step: number,
    unbalanced = false,
    expectedRevision = state.bookRevision,
  ): BookCommand {
    const tx: JournalTransaction = Object.freeze({
      id: journalId(id),
      kind: "ordinary" as const,
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant(`${day}T10:00:00Z`),
      accountingDate: localDate(day),
      recordedAt: instant(`${day}T11:00:00Z`),
      narration: `Property step ${step}`,
      postings: Object.freeze([
        Object.freeze({
          id: postingId(`${id}-p1`),
          ordinal: 1n,
          accountId: IDS.cash,
          units: Object.freeze({ canonicalNumber: ExactRational.of(cents, 100n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(cents, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
        Object.freeze({
          id: postingId(`${id}-p2`),
          ordinal: 2n,
          accountId: step % 2 === 0 ? IDS.revenue : (identifier<"Account">("account-EXPENSE") as AccountId),
          units: Object.freeze({ canonicalNumber: ExactRational.of(-cents, 100n), commodityId: IDS.usd }),
          bookValue: Object.freeze({ amount: ExactDecimal.of(-cents, 2n), functionalCommodityId: IDS.usd }),
          dimensionMemberIds: Object.freeze([]),
        }),
      ]),
    });
    const baseResolved = resolved(tx);
    const suppliedResolved = unbalanced
      ? Object.freeze({
          ...baseResolved,
          journal: Object.freeze({
            ...baseResolved.journal,
            postings: Object.freeze([
              baseResolved.journal.postings[0]!,
              Object.freeze({
                ...baseResolved.journal.postings[1]!,
                bookValue: Object.freeze({
                  ...baseResolved.journal.postings[1]!.bookValue,
                  amount: ExactDecimal.of(-cents - 1n, 2n),
                }),
              }),
            ]),
          }),
        })
      : baseResolved;
    return sealCommand({
      id: commandId(id),
      protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book,
      expectedBookRevision: expectedRevision,
      ...makeTimes(day, step * 5),
      actorId: IDS.actor,
      type: "postJournal" as const,
      resolved: suppliedResolved,
    } as never);
  }

  function buildReversalCommand(
    state: BookState,
    id: string,
    target: BookState["journals"][number],
    day: string,
    step: number,
  ): BookCommand {
    const tx: JournalTransaction = Object.freeze({
      id: journalId(id),
      kind: "reversing" as const,
      bookId: IDS.book,
      functionalCommodityId: IDS.usd,
      economicAt: instant(`${day}T10:00:00Z`),
      accountingDate: localDate(day),
      recordedAt: instant(`${day}T11:00:00Z`),
      narration: `Reverse ${target.journal.id}`,
      postings: Object.freeze(
        target.journal.postings.map((p, idx) =>
          Object.freeze({
            id: postingId(`${id}-rev-${idx}`),
            ordinal: BigInt(idx + 1),
            accountId: p.accountId,
            units: Object.freeze({ canonicalNumber: p.units.canonicalNumber.negate(), commodityId: p.units.commodityId }),
            bookValue: Object.freeze({ amount: p.bookValue.amount.negate(), functionalCommodityId: p.bookValue.functionalCommodityId }),
            dimensionMemberIds: p.dimensionMemberIds,
          }),
        ),
      ),
    });
    const baseResolved = resolved(tx);
    const withLineage = Object.freeze({
      ...baseResolved,
      derivations: Object.freeze([
        Object.freeze({
          id: derivationId(`derivation-${id}`),
          policyId: state.policies[0]!.id,
          policyVersion: state.policies[0]!.version,
          algorithmVersion: semanticVersion("1.0.0"),
          inputHash: hashCanonical({ original: target.journal.id }),
          actorId: IDS.actor,
          state: "approved" as const,
          recordedAt: instant(`${day}T11:00:00Z`),
          evidence: Object.freeze([
            Object.freeze({
              id: evidenceId(`evidence-${id}`),
              sourceSystem: "property-test",
              sourceRecordId: target.journal.id,
              observedAt: instant(`${day}T10:00:00Z`),
              contentHash: target.canonicalHash,
            }),
          ]),
        }),
      ]),
    });
    return sealCommand({
      id: commandId(id),
      protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book,
      expectedBookRevision: state.bookRevision,
      ...makeTimes(day, step * 5),
      actorId: IDS.actor,
      type: "correctJournal" as const,
      correctionKind: "reversal" as const,
      originalJournalId: target.journal.id,
      resolved: withLineage,
    });
  }

  type Action =
    | { readonly kind: "post"; readonly cents: number; readonly dayIdx: number }
    | { readonly kind: "postUnbalanced"; readonly cents: number; readonly dayIdx: number }
    | { readonly kind: "postStale"; readonly cents: number; readonly dayIdx: number }
    | { readonly kind: "reverse"; readonly targetIdx: number; readonly dayIdx: number }
    | { readonly kind: "close"; readonly periodIdx: number }
    | { readonly kind: "reopen"; readonly periodIdx: number }
    | { readonly kind: "replay"; readonly prevIdx: number }
    | { readonly kind: "roundtrip" };

  const arbAction: fc.Arbitrary<Action> = fc.oneof(
    { weight: 5, arbitrary: fc.record({ kind: fc.constant("post" as const), cents: fc.integer({ min: 1, max: 50_000 }), dayIdx: fc.integer({ min: 0, max: 5 }) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("postUnbalanced" as const), cents: fc.integer({ min: 1, max: 50_000 }), dayIdx: fc.integer({ min: 0, max: 5 }) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("postStale" as const), cents: fc.integer({ min: 1, max: 50_000 }), dayIdx: fc.integer({ min: 0, max: 5 }) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("reverse" as const), targetIdx: fc.integer({ min: 0, max: 20 }), dayIdx: fc.integer({ min: 0, max: 5 }) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("close" as const), periodIdx: fc.integer({ min: 0, max: 1 }) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("reopen" as const), periodIdx: fc.integer({ min: 0, max: 1 }) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("replay" as const), prevIdx: fc.integer({ min: 0, max: 20 }) }) },
    { weight: 2, arbitrary: fc.constant({ kind: "roundtrip" as const }) },
  );

  const DAYS = ["2026-01-05", "2026-01-15", "2026-01-25", "2026-02-05", "2026-02-15", "2026-02-25"] as const;

  test("arbitrary command sequences preserve balance, immutability, idempotency, period locks, projection tie-out, and durable codec round-trips", () => {
    fc.assert(
      fc.property(fc.array(arbAction, { minLength: 5, maxLength: 28 }), (actions) => {
        let { state, protocol } = bootActiveBook();
        const committedCommands: BookCommand[] = [];
        const closedPeriods = new Set<string>();
        const reversedJournalIds = new Set<string>();
        let priorJournalDigests: string[] = [];

        for (let step = 0; step < actions.length; step += 1) {
          const action = actions[step]!;
          if (action.kind === "roundtrip") {
            const encoded = encodeDurableBook({ state, protocol });
            const decoded = decodeDurableBook(encoded);
            expect(decoded.disposition).toBe("decoded");
            if (decoded.disposition === "decoded") {
              expect(decoded.aggregate.state.contentHash.digest).toBe(state.contentHash.digest);
              expect(decoded.aggregate.state.bookRevision).toBe(state.bookRevision);
              expect(validateBookState(decoded.aggregate.state)).toEqual([]);
              state = decoded.aggregate.state;
              protocol = decoded.aggregate.protocol;
            }
            continue;
          }

          let command: BookCommand;
          let expectRejected = false;
          let isReplay = false;
          const id = `fc-${step}`;

          if (action.kind === "post") {
            const day = DAYS[action.dayIdx]!;
            const periodId = action.dayIdx < 3 ? periods[0]!.id : periods[1]!.id;
            command = buildPostCommand(state, id, BigInt(action.cents), day, step);
            if (closedPeriods.has(periodId)) expectRejected = true;
          } else if (action.kind === "postUnbalanced") {
            command = buildPostCommand(state, id, BigInt(action.cents), DAYS[action.dayIdx]!, step, true);
            expectRejected = true;
          } else if (action.kind === "postStale") {
            command = buildPostCommand(state, id, BigInt(action.cents), DAYS[action.dayIdx]!, step, false, state.bookRevision - 1n);
            expectRejected = true;
          } else if (action.kind === "reverse") {
            if (state.journals.length === 0) continue;
            const target = state.journals[action.targetIdx % state.journals.length]!;
            const day = DAYS[action.dayIdx]!;
            const periodId = action.dayIdx < 3 ? periods[0]!.id : periods[1]!.id;
            command = buildReversalCommand(state, id, target, day, step);
            if (
              closedPeriods.has(periodId) ||
              reversedJournalIds.has(target.journal.id) ||
              day < target.journal.accountingDate
            ) {
              expectRejected = true;
            }
          } else if (action.kind === "close") {
            const period = periods[action.periodIdx]!;
            command = sealCommand({
              id: commandId(id),
              protocolVersion: semanticVersion("1.0.0"),
              bookId: IDS.book,
              expectedBookRevision: state.bookRevision,
              ...makeTimes("2026-03-01", step * 5),
              actorId: IDS.actor,
              type: "closePeriod" as const,
              periodId: period.id,
              closePackageId: closePackageId(`pkg-${step}`),
              reason: "property close",
              reportPopulationHash: reportHash,
              reportingPolicySnapshotHash: reportPolicyHash,
            } as never);
            if (closedPeriods.has(period.id)) expectRejected = true;
          } else if (action.kind === "reopen") {
            const period = periods[action.periodIdx]!;
            command = sealCommand({
              id: commandId(id),
              protocolVersion: semanticVersion("1.0.0"),
              bookId: IDS.book,
              expectedBookRevision: state.bookRevision,
              ...makeTimes("2026-03-01", step * 5),
              actorId: IDS.actor,
              type: "reopenPeriod" as const,
              periodId: period.id,
              reason: "property reopen",
            } as never);
            if (!closedPeriods.has(period.id)) expectRejected = true;
          } else {
            if (committedCommands.length === 0) continue;
            command = committedCommands[action.prevIdx % committedCommands.length]!;
            isReplay = true;
          }

          const beforeRevision = state.bookRevision;
          const beforeHash = state.contentHash.digest;
          const preview = evaluateBookCommand(state, protocol, command);
          const outcome = executeBookCommand(state, protocol, command);

          if (isReplay) {
            expect(outcome.result.disposition).toBe("replayed");
            expect(outcome.state.bookRevision).toBe(beforeRevision);
            expect(outcome.state.contentHash.digest).toBe(beforeHash);
            continue;
          }

          if (expectRejected) {
            expect(outcome.result.disposition).toBe("rejected");
            expect(preview.disposition).toBe("finished");
            if (preview.disposition === "finished") {
              expect(preview.result.disposition).toBe("rejected");
            }
            expect(outcome.state.bookRevision).toBe(beforeRevision);
            expect(outcome.state.contentHash.digest).toBe(beforeHash);
            protocol = outcome.protocol;
            continue;
          }

          if (outcome.result.disposition === "committed") {
            expect(preview.disposition).toBe("ready");
            expect(outcome.state.bookRevision).toBe(beforeRevision + 1n);
            state = outcome.state;
            protocol = outcome.protocol;
            committedCommands.push(command);

            if (command.type === "closePeriod") closedPeriods.add(command.periodId);
            if (command.type === "reopenPeriod") closedPeriods.delete(command.periodId);
            if (command.type === "correctJournal") reversedJournalIds.add(command.originalJournalId);

            // Invariant 1: append-only immutability (every prior journal untouched at same index & sequence)
            expect(state.journals.length).toBeGreaterThanOrEqual(priorJournalDigests.length);
            for (let i = 0; i < priorJournalDigests.length; i += 1) {
              expect(state.journals[i]!.canonicalHash.digest).toBe(priorJournalDigests[i]!);
              expect(state.journals[i]!.postingSequence).toBe(BigInt(i + 1));
            }
            priorJournalDigests = state.journals.map((b) => b.canonicalHash.digest);

            // Invariant 2: every posted journal balances to exact zero
            for (const booked of state.journals) {
              const total = booked.journal.postings.reduce(
                (acc, p) => acc.add(p.bookValue.amount.toRational()),
                ExactRational.zero(),
              );
              expect(total.isZero()).toBeTrue();
            }

            // Invariant 3: state hash, full validation, and trial-balance projection tie-out
            expect(hashBookState(state).digest).toBe(state.contentHash.digest);
            expect(validateBookState(state)).toEqual([]);
            const rebuilt = rebuildAccountBalanceProjection(state.revisions);
            expect(rebuilt.disposition).toBe("rebuilt");
            if (rebuilt.disposition === "rebuilt") {
              const trialSum = rebuilt.checkpoint.accountBalances.reduce(
                (acc, entry) => acc.add(entry.balance),
                ExactRational.zero(),
              );
              expect(trialSum.isZero()).toBeTrue();
            }
          }
        }

        // Always verify final durable codec round-trip
        const finalDecoded = decodeDurableBook(encodeDurableBook({ state, protocol }));
        expect(finalDecoded.disposition).toBe("decoded");
        if (finalDecoded.disposition === "decoded") {
          expect(finalDecoded.aggregate.state.contentHash.digest).toBe(state.contentHash.digest);
        }
      }),
      { seed: SEED, numRuns: 30 },
    );
  });

  test("decodeDurableBook fails closed on arbitrary malformed JSON, tampered checksums, and hostile strings", () => {
    const arbHostilePayload = fc.oneof(
      fc.string(),
      fc.json(),
      fc.record({
        version: fc.oneof(fc.constant("rastrata-book-aggregate-v1"), fc.string()),
        checksum: fc.anything(),
        body: fc.anything(),
      }).map((obj) => JSON.stringify(obj)),
      fc.constant(JSON.stringify({ version: "rastrata-book-aggregate-v1", checksum: { algorithm: "sha256", canonicalizationVersion: "rastrata-canonical-v1", digest: "0".repeat(64) }, body: ["o", [["__proto__", ["s", String.fromCharCode(0xd800)]]]] })),
    );
    fc.assert(
      fc.property(arbHostilePayload, (raw) => {
        const decoded = decodeDurableBook(raw);
        expect(decoded.disposition).toBe("rejected");
      }),
      { seed: SEED + 1, numRuns: 200 },
    );
  });
});

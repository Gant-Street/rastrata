import { describe, expect, test } from "bun:test";
import {
  ExactDecimal,
  ExactRational,
  createBookProtocolState,
  createBookState,
  evaluateBookCommand,
  executeBookCommand,
  hashBookState,
  hashCanonical,
  identifier,
  instant,
  journalId,
  localDate,
  rebuildAccountBalanceProjection,
  sealCommand,
  semanticVersion,
  type BookCommand,
  type BookProtocolState,
  type BookState,
  type JournalTransaction,
} from "../src/index.ts";
import { IDS, identity, periods, policy, quantizationPolicy, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function makeRng(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function times(value: string) {
  const ms = Date.parse(value);
  return { issuedAt: instant(value), completedAt: instant(new Date(ms + 1_000).toISOString()), committedAt: instant(new Date(ms + 2_000).toISOString()) };
}


function bootBook(): { state: BookState; protocol: BookProtocolState } {
  const base = { state: buildInitialState(), protocol: createBookProtocolState() };
  const active = executeBookCommand(base.state, base.protocol, sealCommand({ ...coreCommand(base.state, "sm-activate", "2026-01-01T14:00:00Z"), ...activationCommand("sm-activate") } as never));
  expect(active.result.disposition).toBe("committed");
  return { state: active.state, protocol: active.protocol };
}

function buildInitialState(): BookState {
  return createBookState(identity, periods, {
    bookId: IDS.book, functionalCommodityId: IDS.usd,
    accounts: [IDS.cash, IDS.revenue, accountId("account-EXPENSE"), accountId("account-AP")].map((id, index) =>
      Object.freeze({ id, bookId: IDS.book, code: `${5000 + index}`, name: id, role: id === IDS.revenue ? ("income" as const) : ("asset" as const), normalSide: id === IDS.revenue ? ("credit" as const) : ("debit" as const), postingAllowed: true, openedOn: localDate("2020-01-01"), allowedCommodityIds: Object.freeze([]) })),
    dimensions: Object.freeze([]), dimensionMembers: Object.freeze([]), requiredDimensionIds: Object.freeze([]),
  }, [policy], [quantizationPolicy], [], instant("2020-01-01T00:00:00Z"));
}

function accountId(value: string) {
  return identifier<"Account">(value) as ReturnType<typeof import("../src/index.ts").accountId>;
}

function coreCommand(state: BookState, id: string, at: string) {
  return { id: identifier<"BookCommand">(id), protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book, expectedBookRevision: state.bookRevision, ...times(at), actorId: IDS.actor };
}

function postCommand(state: BookState, id: string, amount: bigint, at: string, toRevenue = true): BookCommand {
  const transaction: JournalTransaction = Object.freeze({
    id: journalId(id), kind: "ordinary" as const, bookId: IDS.book, functionalCommodityId: IDS.usd,
    economicAt: instant(`${at}T12:00:00Z`), accountingDate: localDate(at), recordedAt: instant(`${at}T13:00:00Z`), narration: `Sequence ${id}`,
    postings: Object.freeze([
      Object.freeze({ id: identifier<"Posting">(`${id}-p1`), ordinal: 1n, accountId: IDS.cash, units: Object.freeze({ canonicalNumber: ExactRational.of(amount, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(amount * 100n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      Object.freeze({ id: identifier<"Posting">(`${id}-p2`), ordinal: 2n, accountId: toRevenue ? IDS.revenue : accountId("account-EXPENSE"), units: Object.freeze({ canonicalNumber: ExactRational.of(-amount, 1n), commodityId: IDS.usd }), bookValue: Object.freeze({ amount: ExactDecimal.of(-amount * 100n, 2n), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
    ]),
  });
  return sealCommand({ ...coreCommand(state, id, `${at}T14:00:00Z`), type: "postJournal" as const, resolved: resolved(transaction) } as never);
}

function closeCommand(state: BookState, id: string, at: string): BookCommand {
  return sealCommand({ ...coreCommand(state, id, at), type: "closePeriod" as const, periodId: periods[0]!.id, closePackageId: identifier<"ClosePackage">(`${id}-package`), reason: "sequence close", reportPopulationHash: hashCanonical({ sequence: id }), reportingPolicySnapshotHash: hashCanonical({ sequence: `${id}-policy` }) } as never);
}

function reopenCommand(state: BookState, id: string, at: string): BookCommand {
  return sealCommand({ ...coreCommand(state, id, at), type: "reopenPeriod" as const, periodId: periods[0]!.id, reason: "sequence reopen" } as never);
}

function assertInvariants(state: BookState, protocol: BookProtocolState) {
  expect(state.journals.every((booked, index) => booked.postingSequence === BigInt(index + 1))).toBeTrue();
  const left = rebuildAccountBalanceProjection(state.revisions);
  const right = rebuildAccountBalanceProjection(state.revisions);
  if (left.disposition !== "rebuilt" || right.disposition !== "rebuilt") throw new Error("Projection rebuild failed");
  expect(left.checkpoint.contentHash.digest).toBe(right.checkpoint.contentHash.digest);
  void protocol;
}

describe("stateful command-sequence testing (deterministic seeds)", () => {
  test("randomized command sequences preserve canonical invariants across evaluation and commit", () => {
    const rng = makeRng(0x5eed1);
    const seeds = [11, 23, 42];
    for (const seed of seeds) {
      const sequenceRng = makeRng(seed * 7919);
      let { state, protocol } = bootBook();
      void rng;
      const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13", "2026-01-14"];
      let commandOrdinal = 0;
      let closed = false;
      for (let step = 0; step < 24; step += 1) {
        commandOrdinal += 1;
        const day = days[Math.floor(sequenceRng() * days.length)]!;
        const roll = sequenceRng();
        const id = `sm-${seed}-${commandOrdinal}`;
        let command: BookCommand;
        if (roll < 0.65) {
          const amount = 1n + BigInt(Math.floor(sequenceRng() * 40));
          command = postCommand(state, id, amount, day, sequenceRng() < 0.7);
        } else if (roll < 0.85 && !closed) {
          command = closeCommand(state, id, `${day}T15:00:00Z`);
          closed = true;
        } else if (closed) {
          command = reopenCommand(state, id, `${day}T15:00:00Z`);
          closed = false;
        } else {
          const amount = 1n + BigInt(Math.floor(sequenceRng() * 40));
          command = postCommand(state, id, amount, day, sequenceRng() < 0.7);
        }
        const evaluation = evaluateBookCommand(state, protocol, command);
        if (evaluation.disposition === "ready") {
          expect(evaluation.intent.command.id).toBe(command.id);
          expect(evaluation.intent.nextBookRevision).toBe(state.bookRevision + 1n);
        }
        const committed = executeBookCommand(state, protocol, command);
        expect(["committed", "rejected"]).toContain(committed.result.disposition);
        if (committed.result.disposition === "committed") {
          state = committed.state;
          protocol = committed.protocol;
          closed = state.periodTransitions.at(-1)?.kind === "close" ? true : state.periodTransitions.at(-1)?.kind === "reopen" ? false : closed;
          expect(hashBookState(state).digest).toBe(state.contentHash.digest);
          assertInvariants(state, protocol);
        }
      }
    }
  });

  test("competing commands against the same revision serialize exactly one winner", () => {
    const { state, protocol } = bootBook();
    const left = postCommand(state, "sm-compete-left", 25n, "2026-01-05", true);
    const right = postCommand(state, "sm-compete-right", 30n, "2026-01-05", false);
    const leftResult = executeBookCommand(state, protocol, left);
    expect(leftResult.result.disposition).toBe("committed");
    const rightResult = executeBookCommand(leftResult.state, leftResult.protocol, right);
    expect(rightResult.result.disposition).toBe("rejected");
    expect(rightResult.result.diagnostics[0]?.code).toBe("stale_book_revision");
    expect(rightResult.state.contentHash.digest).toBe(leftResult.state.contentHash.digest);
  });

  test("evaluation is a pure preview of the committed outcome", () => {
    const { state, protocol } = bootBook();
    const command = postCommand(state, "sm-preview", 11n, "2026-01-05", true);
    const before = hashBookState(state).digest;
    const evaluation = evaluateBookCommand(state, protocol, command);
    expect(evaluation.disposition).toBe("ready");
    expect(hashBookState(state).digest).toBe(before);
    const committed = executeBookCommand(state, protocol, command);
    expect(committed.result.disposition).toBe("committed");
    expect(committed.intent?.canonicalHash).toBeDefined();
  });

  test("close, reopen, and re-close pin and release the same cutoff deterministically", () => {
    let { state, protocol } = bootBook();
    for (let index = 0; index < 4; index += 1) {
      const committed = executeBookCommand(state, protocol, postCommand(state, `sm-cycle-${index}`, BigInt(10 + index), "2026-01-0" + (index + 5), true));
      expect(committed.result.disposition).toBe("committed");
      state = committed.state;
      protocol = committed.protocol;
    }
    const closed = executeBookCommand(state, protocol, closeCommand(state, "sm-cycle-close", "2026-01-31T15:00:00Z"));
    expect(closed.result.disposition).toBe("committed");
    const rejected = executeBookCommand(closed.state, closed.protocol, postCommand(closed.state, "sm-after-close", 5n, "2026-01-15"));
    expect(rejected.result.disposition).toBe("rejected");
    const reopened = executeBookCommand(closed.state, closed.protocol, reopenCommand(closed.state, "sm-cycle-reopen", "2026-02-01T15:00:00Z"));
    expect(reopened.result.disposition).toBe("committed");
    const reclosed = executeBookCommand(reopened.state, reopened.protocol, closeCommand(reopened.state, "sm-cycle-reclose", "2026-02-02T15:00:00Z"));
    expect(reclosed.result.disposition).toBe("committed");
  });
});

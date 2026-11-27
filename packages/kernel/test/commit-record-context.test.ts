import { expect, test } from "bun:test";
import {
  prepareBookCommitRecords, evaluateBookCommand, executeBookCommand, commitBookIntent,
  hashCanonical, canonicalAccountingValue, hashCommitIntent, sealCommand,
  commandId, actorId, bookId, semanticVersion, instant,
  type BookCommitIntent, type BookCommitRecordContext,
} from "../src/index.ts";
import { freshState, journal, resolved, IDS } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function posting() {
  return sealCommand({
    id: commandId("records-post"), type: "postJournal", protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book, expectedBookRevision: 1n, actorId: IDS.actor,
    issuedAt: instant("2026-01-15T14:00:00Z"), completedAt: instant("2026-01-15T14:00:01Z"),
    committedAt: instant("2026-01-15T14:00:02Z"), resolved: resolved(journal("records-post", "2026-01-15")),
  });
}
function digest(value: unknown) { return hashCanonical(canonicalAccountingValue(value)).digest; }
function fixture() {
  const initial = freshState();
  const first = executeBookCommand(initial.state, initial.protocol, activationCommand());
  const command = posting();
  const evaluation = evaluateBookCommand(first.state, first.protocol, command);
  if (evaluation.disposition !== "ready") throw new Error("Missing exact posting intent");
  const context: BookCommitRecordContext = {
    bookId: IDS.book, bookRevision: 1n, previousRevision: first.state.revisions[0]!,
  };
  return { initial, first, command, intent: evaluation.intent, context };
}

test("record construction preserves pre-refactor activation and posting commitments without historical arrays", () => {
  const initial = freshState();
  let aggregate = initial;
  // Captured from the unmodified engine BEFORE extracting the constructor.
  const expected = [
    ["9b9cd0f6a3723f24600f6b36aa0f5bfc0f2f47e22f3a994e4793bfc26d843890", "6ce770fae170f2d0f1c8e5fb328396aa807597083692609d020d0cb7530f8ce2"],
    ["acc64317364dbb18dab48494bc6c9f4337453b42f04ab6c2a89b5e56de91c078", "62b91a6cd10dfa740b53b80c617d4eba6037850c635c4be9b7474f4a20cc5acd"],
  ];
  for (const [index, command] of [activationCommand(), posting()].entries()) {
    const evaluated = evaluateBookCommand(aggregate.state, aggregate.protocol, command);
    if (evaluated.disposition !== "ready") throw new Error("Missing intent");
    const records = prepareBookCommitRecords({
      bookId: IDS.book, bookRevision: aggregate.state.bookRevision,
      previousRevision: aggregate.state.revisions.at(-1) ?? null,
    }, evaluated.intent);
    expect(digest(records)).toBe(expected[index]![0]!);
    const complete = executeBookCommand(aggregate.state, aggregate.protocol, command);
    expect(records).toEqual({ revision: complete.state.revisions.at(-1)!, retained: complete.protocol.retainedResults.at(-1)!, result: complete.result });
    expect(complete.state.contentHash.digest).toBe(expected[index]![1]!);
    aggregate = { state: complete.state, protocol: complete.protocol };
  }
});

test("a retained rejection never becomes the financial revision predecessor", () => {
  const f = fixture();
  const rejected = executeBookCommand(f.first.state, f.first.protocol, activationCommand("retained-rejection", 999n));
  expect(rejected.result.disposition).toBe("rejected");
  expect(rejected.protocol.retainedResults).toHaveLength(2);
  expect(rejected.state.revisions).toHaveLength(1);
  const records = prepareBookCommitRecords(f.context, f.intent);
  const next = executeBookCommand(rejected.state, rejected.protocol, f.command);
  expect(records).toEqual({ revision: next.state.revisions.at(-1)!, retained: next.protocol.retainedResults.at(-1)!, result: next.result });
  expect(records.revision.bookRevision).toBe(2n);
  expect(records.revision.previousHash).toEqual(f.first.state.revisions[0]!.chainHash);
  expect(next.protocol.retainedResults).toHaveLength(3);
  expect(digest(records)).toBe("acc64317364dbb18dab48494bc6c9f4337453b42f04ab6c2a89b5e56de91c078");
});

test("record construction rejects unresolved, foreign or inconsistent predecessor and intent content", () => {
  const f = fixture();
  const previous = f.context.previousRevision!;
  const contexts: unknown[] = [
    { ...f.context, bookRevision: -1n }, { ...f.context, bookRevision: "1" },
    { ...f.context, bookId: bookId("foreign") }, { ...f.context, bookRevision: 2n },
    { ...f.context, previousRevision: null }, { ...f.context, previousRevision: undefined },
    { ...f.context, previousRevision: { ...previous, bookId: bookId("foreign") } },
    { ...f.context, previousRevision: { ...previous, bookRevision: 2n } },
    { ...f.context, previousRevision: { ...previous, chainHash: {} } },
    ...[
      { ...previous.chainHash, algorithm: "forged" },
      { ...previous.chainHash, canonicalizationVersion: "forged" },
      { ...previous.chainHash, digest: 1 }, { ...previous.chainHash, digest: "short" },
    ].map((chainHash) => ({ ...f.context, previousRevision: { ...previous, chainHash } })),
  ];
  for (const context of contexts)
    expect(() => prepareBookCommitRecords(context as BookCommitRecordContext, f.intent)).toThrow("Incomplete or inconsistent commit record context");
  expect(() => prepareBookCommitRecords(f.context, { ...f.intent, nextBookRevision: 3n })).toThrow("Incomplete or inconsistent commit record context");
  const initial = evaluateBookCommand(f.initial.state, f.initial.protocol, activationCommand());
  if (initial.disposition !== "ready") throw new Error("Missing activation");
  expect(() => prepareBookCommitRecords({ bookId: IDS.book, bookRevision: 0n, previousRevision: previous }, initial.intent)).toThrow("Incomplete or inconsistent commit record context");
  for (const intent of [
    { ...f.intent, effects: [] },
    { ...f.intent, canonicalHash: hashCanonical({ forged: true }) },
    { ...f.intent, command: { ...f.command, actorId: actorId("forged") } },
  ]) expect(() => prepareBookCommitRecords(f.context, intent)).toThrow("Commit record intent content mismatch");
});

test("record candidates own their inputs and cannot authorize a forged economic intent", () => {
  const f = fixture();
  const mutable = { ...f.intent, command: { ...f.command }, effects: [...f.intent.effects] };
  const predecessor = { ...f.context.previousRevision!, chainHash: { ...f.context.previousRevision!.chainHash } };
  const records = prepareBookCommitRecords({ ...f.context, previousRevision: predecessor }, mutable);
  mutable.command.expectedBookRevision = 99n;
  mutable.effects.length = 0;
  predecessor.chainHash.digest = "0".repeat(64);
  expect(digest(records)).toBe("acc64317364dbb18dab48494bc6c9f4337453b42f04ab6c2a89b5e56de91c078");
  expect(Object.isFrozen(records.retained.command)).toBe(true);
  expect(Object.isFrozen(records.revision.effects)).toBe(true);
  expect(Object.isFrozen(records.revision.previousHash)).toBe(true);
  const forged: BookCommitIntent = {
    ...f.intent, effects: [],
    canonicalHash: hashCommitIntent(f.intent.command, f.intent.expectedBookRevision, f.intent.nextBookRevision,
      f.intent.resultingPostingSequence, f.intent.expectedConfigurationRevision, f.intent.nextConfigurationRevision,
      f.intent.resultingConfigurationHash, []),
  };
  expect(prepareBookCommitRecords(f.context, forged).revision.effects).toEqual([]);
  const refused = commitBookIntent(f.first.state, f.first.protocol, forged);
  expect(refused.result.disposition).toBe("rejected");
  expect(refused.result.diagnostics[0]?.code).toBe("ordered_history_violation");
  expect(refused.state).toBe(f.first.state);
  expect(refused.protocol).toBe(f.first.protocol);
});

import { beforeEach, describe, expect, test } from "bun:test";
import {
  CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  bookHistoryMaterializations,
  commandId,
  createBookState,
  decodeDurableBook,
  derivationId,
  encodeDurableBook,
  evaluateBookCommand,
  evidenceId,
  executeBookCommand,
  hashBookState,
  hashCanonical,
  instant,
  latestRetainedCommandResult,
  latestRevisionRecord,
  localDate,
  sealCommand,
  semanticVersion,
  validateBookProtocol,
  validateBookState,
  type AtomicBookCommit,
  type BookCommand,
  type BookedJournal,
  type BookState,
} from "../src/index.ts";
import {
  historyStats,
  journalLogOf,
  journalsOf,
  retainedLogOf,
  retainedResultsOf,
  revisionLogOf,
  revisionsOf,
  type Log,
} from "../src/book-history.ts";
import { IDS, closePackageId, freshState, journal, reportHash, reportPolicyHash, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

type Book = AtomicBookCommit;

function times(at: string) {
  const millis = Date.parse(at);
  return {
    issuedAt: instant(at),
    completedAt: instant(new Date(millis + 1_000).toISOString()),
    committedAt: instant(new Date(millis + 2_000).toISOString()),
  };
}

/** Whether the books the helpers make carry the state commitment profile. */
let commitment = false;

/** The fixture book's genesis, with the state commitment profile when `commitment` says so. */
function freshBook() {
  const base = freshState();
  if (!commitment) return base;
  const c = base.state.activeConfigurationSnapshot;
  return {
    protocol: base.protocol,
    state: createBookState(base.state.identity, c.periods, c.admissionSnapshot, c.policies, c.quantizationPolicies, c.accountingPolicySnapshot.policies, c.effectiveAt, undefined, CHAIN_HEAD_STATE_COMMITMENT_PROFILE),
  };
}

function activated(): Book {
  const fresh = freshBook();
  return executeBookCommand(fresh.state, fresh.protocol, activationCommand("history-activate"));
}

function post(state: BookState, name: string, date = "2026-01-15", at = `${date}T14:00:00Z`): BookCommand {
  return sealCommand({
    id: commandId(`post-${name}`),
    type: "postJournal",
    protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book,
    expectedBookRevision: state.bookRevision,
    ...times(at),
    actorId: IDS.actor,
    resolved: resolved(journal(name, date)),
  });
}

function posted(book: Book, name: string, date = "2026-01-15"): Book {
  const next = executeBookCommand(book.state, book.protocol, post(book.state, name, date));
  expect(next.result.disposition).toBe("committed");
  return next;
}

function bookOf(count: number, prefix = "j"): Book {
  let book = activated();
  for (let index = 1; index <= count; index += 1) book = posted(book, `${prefix}${index}`);
  return book;
}

function rng(seed: number): () => number {
  let value = seed | 0 || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

function ids(list: readonly BookedJournal[]): string[] {
  return list.map((booked) => booked.journal.id);
}

/** Everything a Log answers, checked against the plain array it must be equivalent to. */
function expectLogEquals(log: Log<BookedJournal>, model: readonly BookedJournal[], probes: readonly string[]) {
  expect(log.length).toBe(model.length);
  const array = log.array();
  expect(Object.isFrozen(array)).toBeTrue();
  expect(array).toHaveLength(model.length);
  array.forEach((booked, index) => expect(booked).toBe(model[index]!));
  expect(log.array()).toBe(array);
  for (const position of [0, 1, 2, model.length - 1, model.length, -1, -2, -model.length, -model.length - 1]) {
    expect(log.at(position)).toBe(model.at(position));
  }
  // The first-match scan is remembered per name, so a name is always asked with the same test.
  for (const watched of ["j3", "j7"]) {
    expect(log.firstWhere(`is-${watched}`, (booked) => booked.journal.id === watched)).toBe(
      model.find((booked) => booked.journal.id === watched),
    );
  }
  for (const id of probes) {
    expect(log.has("journal", id)).toBe(model.some((booked) => booked.journal.id === id));
    expect(log.first("journal", id)).toBe(model.find((booked) => booked.journal.id === id));
    expect(log.all("journal", id)).toEqual(model.filter((booked) => booked.journal.id === id));
    const owner = model.find((booked) => booked.journal.postings.some((posting) => posting.id === id));
    expect(log.has("posting", id)).toBe(owner !== undefined);
    expect(log.first("posting", id)).toBe(owner);
  }
}

describe("book history: the lists of a built state are lazily frozen views over a shared store", () => {
  test("a view answers like the plain array it stands for, for every probe, including duplicates", () => {
    const pool = bookOf(12).state.journals;
    const probes = [...ids(pool), ...pool.map((booked) => `${booked.journal.id}-debit`), "absent", "j1-credit"];
    const model: BookedJournal[] = [];
    let log = journalLogOf({ journals: [] });
    expectLogEquals(log, model, probes);
    const draw = rng(0xfeed);
    for (let step = 0; step < 60; step += 1) {
      const added = Array.from({ length: 1 + Math.floor(draw() * 3) }, () => pool[Math.floor(draw() * pool.length)]!);
      log = log.append(added);
      model.push(...added);
      expectLogEquals(log, model, probes);
    }
    expect(log.append([])).toBe(log);
  });

  test("at() answers exactly as Array.prototype.at does, for any position", () => {
    const pool = bookOf(4).state.journals;
    const log = journalLogOf({ journals: [] }).append([...pool]);
    const array = [...pool];
    const positions = [0, 1, 3, 4, -1, -4, -5, 1.9, -1.9, 0.5, -0.5, Number.NaN, -0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 40, -(2 ** 40)];
    for (const position of positions) expect(log.at(position), String(position)).toBe(array.at(position));
    expect(log.at("2" as unknown as number)).toBe(array.at("2" as unknown as number));
    expect(journalLogOf({ journals: [] }).at(0)).toBeUndefined();
    expect(journalLogOf({ journals: [] }).at(-1)).toBeUndefined();
  });

  test("two views derived from one view never see each other's items, whatever order they grow in", () => {
    const pool = bookOf(10).state.journals;
    const probes = [...ids(pool), ...pool.map((booked) => `${booked.journal.id}-credit`)];
    const draw = rng(0xbeef);
    const views: { log: Log<BookedJournal>; model: BookedJournal[] }[] = [{ log: journalLogOf({ journals: [] }), model: [] }];
    const copiedBefore = historyStats.copied;
    for (let step = 0; step < 200; step += 1) {
      const from = views[Math.floor(draw() * views.length)]!;
      const added = Array.from({ length: Math.floor(draw() * 3) }, () => pool[Math.floor(draw() * pool.length)]!);
      views.push({ log: from.log.append(added), model: [...from.model, ...added] });
      // Every view ever made, including the ones that were extended afterwards, is unchanged.
      if (step % 20 === 19) for (const view of views) expectLogEquals(view.log, view.model, probes);
    }
    for (const view of views) expectLogEquals(view.log, view.model, probes);
    expect(historyStats.copied).toBeGreaterThan(copiedBefore);
  });

  test("a view of a plain array copies nothing until it grows, and an unfrozen array is never remembered", () => {
    const pool = bookOf(4).state.journals;
    const frozen = Object.freeze([pool[0]!, pool[1]!]);
    const first = journalLogOf({ journals: frozen });
    expect(journalLogOf({ journals: frozen })).toBe(first);
    expect(first.array()).toBe(frozen);
    const copied = historyStats.copied;
    const grown = first.append([pool[2]!]);
    expect(historyStats.copied).toBe(copied + 1);
    expect(grown.array()).toHaveLength(3);
    expect(frozen).toHaveLength(2);
    expect(grown.array()[2]).toBe(pool[2]!);
    // Growing the head again extends in place; the original frozen array is untouched throughout.
    expect(grown.append([pool[3]!]).length).toBe(4);
    expect(historyStats.copied).toBe(copied + 1);

    const unfrozen = [pool[0]!, pool[1]!];
    const before = journalLogOf({ journals: unfrozen });
    expect(before.has("journal", pool[2]!.journal.id)).toBeFalse();
    unfrozen.push(pool[2]!);
    const after = journalLogOf({ journals: unfrozen });
    expect(after).not.toBe(before);
    expect(after.has("journal", pool[2]!.journal.id)).toBeTrue();
    expect(before.has("journal", pool[2]!.journal.id)).toBeFalse();
  });

  test("a lookup indexes each item once, however many views and lookups there are", () => {
    const pool = bookOf(6).state.journals;
    let log = journalLogOf({ journals: [] });
    for (const booked of pool) log = log.append([booked]);
    const before = historyStats.indexed;
    expect(log.has("journal", "j1")).toBeTrue();
    expect(historyStats.indexed).toBe(before + 6);
    expect(log.has("journal", "j6")).toBeTrue();
    expect(log.has("posting", "j2-debit")).toBeTrue();
    expect(historyStats.indexed).toBe(before + 12);
    log.has("journal", "nothing");
    log = log.append([pool[0]!]);
    expect(log.has("journal", "j1")).toBeTrue();
    expect(historyStats.indexed).toBe(before + 13);
    expect(() => log.has("no-such-lookup", "x")).toThrow(RangeError);
  });

  test("the first match is found by scanning only as far as it, and resumes where it stopped", () => {
    const pool = bookOf(5).state.journals;
    let log = journalLogOf({ journals: [] }).append([pool[0]!, pool[1]!]);
    const isThird = (booked: BookedJournal) => booked.journal.id === "j3";
    let tested = 0;
    const test3 = (booked: BookedJournal) => {
      tested += 1;
      return isThird(booked);
    };
    expect(log.firstWhere("third", test3)).toBeUndefined();
    expect(tested).toBe(2);
    log = log.append([pool[2]!, pool[3]!, pool[4]!]);
    expect(log.firstWhere("third", test3)).toBe(pool[2]!);
    expect(tested).toBe(3);
    expect(log.firstWhere("third", test3)).toBe(pool[2]!);
    expect(tested).toBe(3);
    // A shorter view of the same store does not see a match that lies beyond its end.
    expect(journalLogOf({ journals: pool.slice(0, 2).concat() }).firstWhere("third", isThird)).toBeUndefined();
    const head = journalLogOf({ journals: [] }).append([pool[0]!, pool[1]!]);
    const longer = head.append([pool[2]!]);
    expect(longer.firstWhere("third", isThird)).toBe(pool[2]!);
    expect(head.firstWhere("third", isThird)).toBeUndefined();
  });

  test("an item whose keys cannot be read fails the lookup and leaves the index consistent", () => {
    const pool = bookOf(2).state.journals;
    const broken = { journal: undefined } as unknown as BookedJournal;
    const log = journalLogOf({ journals: [] }).append([pool[0]!, broken, pool[1]!]);
    expect(() => log.has("journal", "j1")).toThrow(TypeError);
    expect(() => log.has("journal", "j1")).toThrow(TypeError);
    expect(journalLogOf({ journals: [] }).append([pool[0]!]).has("journal", "j1")).toBeTrue();
  });
});

for (const profiled of [false, true]) {
  const kind = profiled ? "a book with the state commitment profile" : "a book without it";
  describe(kind, () => {
    beforeEach(() => {
      commitment = profiled;
    });
    test("the helpers build the kind of book this suite is about", () => {
      expect(activated().state.activeConfigurationSnapshot.stateCommitmentProfile).toBe(profiled ? CHAIN_HEAD_STATE_COMMITMENT_PROFILE : undefined);
      expect(posted(activated(), "kind-check").state.contentHash.digest).toHaveLength(64);
    });
    describe(`book history: the arrays a caller can obtain are frozen, always`, () => {
      function everyList(book: Book): Record<string, readonly unknown[]> {
        const { state, protocol } = book;
        return {
          journals: state.journals,
          revisions: state.revisions,
          corrections: state.corrections,
          periodTransitions: state.periodTransitions,
          closePackages: state.closePackages,
          configurationSnapshots: state.configurationSnapshots,
          lots: state.lots,
          lotHoldings: state.lotHoldings,
          lotAllocations: state.lotAllocations,
          retainedResults: protocol.retainedResults,
        };
      }

      /** A book that has activated, posted, corrected, closed and reopened, so no list is empty. */
      function busyBook(): Book {
        let book = bookOf(2, "busy");
        const original = book.state.journals[0]!;
        const reversed = resolved(journal("busy-reversal", "2026-01-16", "reversing", true));
        const lineage = Object.freeze({
          ...reversed,
          derivations: Object.freeze([
            Object.freeze({
              id: derivationId("history-correction"),
              policyId: book.state.policies[0]!.id,
              policyVersion: book.state.policies[0]!.version,
              algorithmVersion: semanticVersion("1.0.0"),
              inputHash: hashCanonical({ original: original.journal.id }),
              actorId: IDS.actor,
              state: "approved" as const,
              recordedAt: instant("2026-01-16T13:00:00Z"),
              evidence: Object.freeze([
                Object.freeze({
                  id: evidenceId("history-evidence"),
                  sourceSystem: "manual-review",
                  sourceRecordId: original.journal.id,
                  observedAt: instant("2026-01-16T12:00:00Z"),
                  contentHash: original.canonicalHash,
                }),
              ]),
            }),
          ]),
        });
        book = executeBookCommand(
          book.state,
          book.protocol,
          sealCommand({
            id: commandId("history-correction"),
            type: "correctJournal",
            protocolVersion: semanticVersion("1.0.0"),
            bookId: IDS.book,
            expectedBookRevision: book.state.bookRevision,
            ...times("2026-01-16T14:00:00Z"),
            actorId: IDS.actor,
            correctionKind: "reversal",
            originalJournalId: original.journal.id,
            resolved: lineage,
          }),
        );
        expect(book.result.disposition).toBe("committed");
        const close = sealCommand({
          id: commandId("history-close"),
          type: "closePeriod",
          protocolVersion: semanticVersion("1.0.0"),
          bookId: IDS.book,
          expectedBookRevision: book.state.bookRevision,
          ...times("2026-02-01T00:00:00Z"),
          actorId: IDS.actor,
          periodId: IDS.period1,
          closePackageId: closePackageId("history-close-package"),
          reason: "Reviewed",
          reportPopulationHash: reportHash,
          reportingPolicySnapshotHash: reportPolicyHash,
        });
        book = executeBookCommand(book.state, book.protocol, close);
        expect(book.result.disposition).toBe("committed");
        book = executeBookCommand(
          book.state,
          book.protocol,
          sealCommand({
            id: commandId("history-reopen"),
            type: "reopenPeriod",
            protocolVersion: semanticVersion("1.0.0"),
            bookId: IDS.book,
            expectedBookRevision: book.state.bookRevision,
            ...times("2026-02-02T00:00:00Z"),
            actorId: IDS.actor,
            periodId: IDS.period1,
            reason: "More evidence",
          }),
        );
        expect(book.result.disposition).toBe("committed");
        return executeBookCommand(book.state, book.protocol, close); // rejected: retained as a rejection
      }

      test("every list of a built state is frozen and rejects every kind of write in strict mode", () => {
        const book = busyBook();
        expect(book.state.journals.length).toBe(3);
        expect(book.state.corrections.length).toBe(1);
        expect(book.state.closePackages.length).toBe(1);
        expect(book.state.periodTransitions.length).toBe(2);
        for (const [name, list] of Object.entries(everyList(book))) {
          const array = list as unknown[];
          expect(Object.isFrozen(array), name).toBeTrue();
          expect(Array.isArray(array), name).toBeTrue();
          const writes: Record<string, () => unknown> = {
            push: () => array.push({}),
            pop: () => array.pop(),
            shift: () => array.shift(),
            unshift: () => array.unshift({}),
            splice: () => array.splice(0, 1),
            sort: () => array.sort(),
            reverse: () => array.reverse(),
            fill: () => array.fill(0),
            copyWithin: () => array.copyWithin(0, 0),
            "index write": () => {
              (array as { [index: number]: unknown })[0] = {};
            },
            "index write past the end": () => {
              (array as { [index: number]: unknown })[array.length] = {};
            },
            "length write": () => {
              array.length = 0;
            },
            "index delete": () => {
              delete (array as { [index: number]: unknown })[0];
            },
            "property define": () => Object.defineProperty(array, "extra", { value: 1 }),
          };
          for (const [kind, write] of Object.entries(writes)) {
            // Nothing is written by these on an empty list, and sorting or reversing one element writes none.
            if (array.length === 0 && ["pop", "shift", "splice", "sort", "reverse", "fill", "copyWithin", "index delete"].includes(kind)) continue;
            if (array.length < 2 && ["sort", "reverse"].includes(kind)) continue;
            expect(write, `${name}.${kind}`).toThrow(TypeError);
          }
        }
      });

      test("the state and the protocol themselves reject writes, and a list is the same array each time", () => {
        const book = busyBook();
        for (const target of [book.state, book.protocol] as unknown as Record<string, unknown>[]) {
          expect(Object.isFrozen(target)).toBeTrue();
          for (const key of Object.keys(target)) {
            expect(() => {
              target[key] = undefined;
            }, key).toThrow(TypeError);
            expect(() => delete target[key], key).toThrow(TypeError);
            expect(() => Object.defineProperty(target, key, { value: 1 }), key).toThrow(TypeError);
            const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
            expect(descriptor.enumerable, key).toBeTrue();
            expect(descriptor.configurable, key).toBeFalse();
          }
          expect(() => {
            target.added = 1;
          }).toThrow(TypeError);
        }
        expect(book.state.journals).toBe(book.state.journals);
        expect(book.state.revisions).toBe(book.state.revisions);
        expect(book.protocol.retainedResults).toBe(book.protocol.retainedResults);
        const descriptor = Object.getOwnPropertyDescriptor(book.state, "journals")!;
        expect(typeof descriptor.get).toBe("function");
        expect(descriptor.set).toBeUndefined();
      });

      test("a built state has the same keys, in the same order, as the state it was built from", () => {
        const genesis = freshBook();
        const start = executeBookCommand(genesis.state, genesis.protocol, activationCommand("order-activate"));
        const next = posted(start, "order-1");
        expect(Object.keys(next.state)).toEqual(Object.keys(start.state));
        expect(Object.keys(start.state).slice(0, -1)).toEqual([...Object.keys(genesis.state).slice(0, -1), "openingBoundary"].sort((a, b) => Object.keys(start.state).indexOf(a) - Object.keys(start.state).indexOf(b)));
        expect(Object.keys(next.state).at(-1)).toBe("contentHash");
        expect(Object.keys(next.protocol)).toEqual(["retainedResults"]);
      });

      test("a spread, a clone, the durable encoder and toEqual all see ordinary frozen arrays", () => {
        const book = busyBook();
        const spread = { ...book.state };
        expect(spread.journals).toBe(book.state.journals);
        expect(Object.getOwnPropertyDescriptor(spread, "journals")!.value).toBe(book.state.journals);
        const encoded = encodeDurableBook({ state: book.state, protocol: book.protocol });
        const decoded = decodeDurableBook(encoded);
        expect(decoded.disposition).toBe("decoded");
        if (decoded.disposition === "decoded") {
          expect(decoded.aggregate.state).toEqual(book.state);
          expect(encodeDurableBook(decoded.aggregate)).toBe(encoded);
          expect(decoded.aggregate.state.contentHash).toEqual(book.state.contentHash);
        }
        expect(structuredClone({ ...book.state, identity: undefined }).journals).toHaveLength(3);
      });

      test("a state under a spread copy keeps its place in the chain, so it is cheap to extend", () => {
        const book = bookOf(5);
        const copy = { ...book.state } as BookState;
        const copied = historyStats.copied;
        const next = executeBookCommand(copy, book.protocol, post(copy, "after-copy"));
        expect(next.result.disposition).toBe("committed");
        expect(historyStats.copied).toBe(copied);
        expect(ids(next.state.journals)).toEqual(["j1", "j2", "j3", "j4", "j5", "after-copy"]);
      });
    });

    describe(`book history: states derived from one state`, () => {
      test("branches grow independently and every state stays valid, equal to its decoded self", () => {
        const draw = rng(0xc0ffee);
        const first = bookOf(3);
        const pool: { book: Book; model: string[] }[] = [{ book: first, model: ["j1", "j2", "j3"] }];
        let duplicates = 0;
        for (let step = 0; step < 80; step += 1) {
          const from = pool[Math.floor(draw() * pool.length)]!;
          const reuse = draw() < 0.15 && from.model.length > 0;
          const name = reuse ? from.model[Math.floor(draw() * from.model.length)]! : `b${step}`;
          const command = sealCommand({
            id: commandId(`branch-${step}`),
            type: "postJournal",
            protocolVersion: semanticVersion("1.0.0"),
            bookId: IDS.book,
            expectedBookRevision: from.book.state.bookRevision,
            ...times("2026-01-20T14:00:00Z"),
            actorId: IDS.actor,
            resolved: resolved(journal(name, "2026-01-20")),
          });
          const result = executeBookCommand(from.book.state, from.book.protocol, command);
          if (reuse) {
            duplicates += 1;
            expect(result.result.disposition).toBe("rejected");
            expect(result.result.diagnostics[0]?.code).toBe("canonical_identity_conflict");
            // A rejection retains the command and changes nothing else.
            expect(result.state).toBe(from.book.state);
            expect(result.protocol.retainedResults).toHaveLength(from.book.protocol.retainedResults.length + 1);
            pool.push({ book: result, model: from.model });
          } else {
            expect(result.result.disposition).toBe("committed");
            pool.push({ book: result, model: [...from.model, name] });
          }
        }
        expect(duplicates).toBeGreaterThan(0);
        for (const { book, model } of pool) {
          expect(ids(book.state.journals)).toEqual(model);
          expect(book.state.revisions).toHaveLength(Number(book.state.bookRevision));
          expect(book.state.revisions.at(-1)).toBe(latestRevisionRecord(book.state));
          expect(book.protocol.retainedResults.at(-1)).toBe(latestRetainedCommandResult(book.protocol));
          expect(hashBookState(book.state).digest).toBe(book.state.contentHash.digest);
          expect(validateBookState(book.state)).toEqual([]);
          expect(validateBookProtocol(book.state, book.protocol)).toEqual([]);
          const encoded = encodeDurableBook({ state: book.state, protocol: book.protocol });
          const decoded = decodeDurableBook(encoded);
          expect(decoded.disposition).toBe("decoded");
          if (decoded.disposition === "decoded") {
            expect(decoded.aggregate.state.journals).toEqual(book.state.journals);
            expect(encodeDurableBook(decoded.aggregate)).toBe(encoded);
          }
        }
      });

      test("the same commands applied in different orders to a common state give the lists each order implies", () => {
        const base = bookOf(2);
        const names = ["x", "y", "z"];
        const orders = [
          ["x", "y", "z"],
          ["z", "y", "x"],
          ["y", "x", "z"],
          ["x", "z"],
          ["z", "x", "y"],
        ];
        // Every order starts from the same state object, so each one branches off its shared store.
        const results = orders.map((order) => {
          let book = base;
          for (const name of order) book = posted(book, name);
          return { order, book };
        });
        for (const { order, book } of results) {
          expect(ids(book.state.journals)).toEqual(["j1", "j2", ...order]);
          expect(book.state.revisions.map((revision) => revision.command.id as string)).toEqual([
            "history-activate",
            "post-j1",
            "post-j2",
            ...order.map((name) => `post-${name}`),
          ]);
          expect(book.protocol.retainedResults.map((retained) => retained.commandId as string)).toEqual(book.state.revisions.map((revision) => revision.command.id as string));
          expect(validateBookState(book.state)).toEqual([]);
          for (const name of names) {
            const evaluation = evaluateBookCommand(book.state, book.protocol, post(book.state, name, "2026-01-21"));
            const rejected = evaluation.disposition === "finished";
            expect(rejected).toBe(order.includes(name));
          }
        }
        // The common state itself never moved.
        expect(ids(base.state.journals)).toEqual(["j1", "j2"]);
        expect(base.state.revisions).toHaveLength(3);
        expect(base.protocol.retainedResults).toHaveLength(3);
        expect(evaluateBookCommand(base.state, base.protocol, post(base.state, "x")).disposition).toBe("ready");
      });
    });

    describe(`book history: a per-command path never forces the copy`, () => {
      test("replaying commands through executeBookCommand, with nobody reading the lists, materializes nothing", () => {
        const commands: BookCommand[] = [];
        // Build the commands against a throwaway book, and replay them on another book that starts from an
        // identical state: the replay then extends its own stores, as a restart does, and copies nothing.
        let scratch = activated();
        let book = activated();
        // A book without the profile hashes its whole history three times per command, so it gets fewer.
        const count = profiled ? 300 : 120;
        for (let index = 1; index <= count; index += 1) {
          const at = new Date(Date.UTC(2026, 0, 2) + index * 60_000).toISOString();
          const command = post(scratch.state, `hot${index}`, `2026-01-${String(1 + (index % 27)).padStart(2, "0")}`, at);
          commands.push(command);
          scratch = executeBookCommand(scratch.state, scratch.protocol, command);
        }
        const materialized = bookHistoryMaterializations();
        const indexed = historyStats.indexed;
        const copied = historyStats.copied;
        for (const command of commands) {
          const next = executeBookCommand(book.state, book.protocol, command);
          expect(next.result.disposition).toBe("committed");
          expect(latestRevisionRecord(next.state)?.command.id).toBe(command.id);
          expect(latestRetainedCommandResult(next.protocol)?.commandId).toBe(command.id);
          book = next;
        }
        expect(bookHistoryMaterializations()).toBe(materialized);
        // Only the genesis list's frozen array is copied, once, when the first journal arrives; after that
        // the replay extends its own store in place.
        expect(historyStats.copied - copied).toBeLessThanOrEqual(1);
        // Each journal, each posting and each retained result is indexed once, never again.
        expect(historyStats.indexed - indexed).toBeLessThanOrEqual(count * 3);
        // A rejected command, and a preview, read nothing either.
        const rejected = executeBookCommand(book.state, book.protocol, commands[0]!);
        expect(rejected.result.disposition).toBe("replayed");
        expect(evaluateBookCommand(book.state, book.protocol, post(book.state, "preview")).disposition).toBe("ready");
        expect(bookHistoryMaterializations()).toBe(materialized);
        // Reading the lists is what pays, once each.
        expect(book.state.journals).toHaveLength(count);
        expect(bookHistoryMaterializations()).toBe(materialized + 1);
        expect(book.state.journals).toHaveLength(count);
        expect(book.state.revisions).toHaveLength(count + 1);
        expect(book.protocol.retainedResults).toHaveLength(count + 1);
        expect(bookHistoryMaterializations()).toBe(materialized + 3);
      });

      test("a book that adopted structural source identities replays without copying a list", () => {
        const start = activated();
        const adoption = {
          from: "legacy",
          to: STRUCTURAL_SOURCE_IDENTITY_PROFILE,
          expectedConfigurationHash: start.state.configurationHash,
          reason: "Adopt structural source identities prospectively",
          evidenceIds: [evidenceId("history-adoption")],
        };
        const adopted = executeBookCommand(
          start.state,
          start.protocol,
          sealCommand({
            id: commandId("history-adopt"),
            type: "replaceConfiguration",
            protocolVersion: semanticVersion("1.0.0"),
            bookId: IDS.book,
            expectedBookRevision: start.state.bookRevision,
            ...times("2026-01-02T00:00:00Z"),
            actorId: IDS.actor,
            expectedConfigurationRevision: start.state.configurationRevision,
            effectiveOn: localDate("2026-01-02"),
            periods: start.state.periods,
            admissionSnapshot: start.state.admissionSnapshot,
            policies: start.state.policies,
            quantizationPolicies: start.state.quantizationPolicies,
            accountingPolicies: start.state.accountingPolicySnapshot.policies,
            executionProfileAdoption: adoption,
          }),
        );
        expect(adopted.result.disposition).toBe("committed");
        expect(adopted.state.configurationSnapshots.map((snapshot) => snapshot.executionProfile)).toEqual([undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE]);
        // Every command's admission checks the snapshot where the profile changed against the revision that
        // made the change; that lookup is by index, not by reading the revisions.
        const before = bookHistoryMaterializations();
        let book = adopted;
        for (let index = 1; index <= 30; index += 1) book = posted(book, `adopted-${index}`);
        expect(bookHistoryMaterializations()).toBe(before);
        expect(book.state.journals).toHaveLength(30);
        expect(validateBookState(book.state)).toEqual([]);
      });

      test("the retained-result and revision views find a command by identifier, in order, and agree with the arrays", () => {
        const book = bookOf(4);
        const retained = retainedLogOf(book.protocol);
        const revisions = revisionLogOf(book.state);
        for (const [index, item] of book.protocol.retainedResults.entries()) {
          expect(retained.first("command", item.commandId)).toBe(item);
          expect(retained.at(index)).toBe(item);
        }
        expect(retained.first("command", "absent")).toBeUndefined();
        expect(revisions.all("configuration", "0")).toEqual([]);
        expect(revisions.length).toBe(5);
      });
    });

    describe(`book history: reading the end of a list is O(1) for every kind of state`, () => {
      test("a plain state answers with its own array, and nothing but the length and the last index is read", () => {
        const book = bookOf(5);
        const reads: string[] = [];
        const watched = new Proxy(Object.freeze([...book.state.journals]), {
          get(target, property, receiver) {
            reads.push(String(property));
            return Reflect.get(target, property, receiver);
          },
        });
        const view = journalsOf({ journals: watched });
        expect(view).toBe(watched);
        expect(view.length).toBe(5);
        expect(view.at(-1)?.journal.id as string).toBe("j5");
        expect(reads.filter((name) => /^\d+$/.test(name))).toEqual(["4"]);
        const revisions = [...book.state.revisions];
        expect(revisionsOf({ revisions })).toBe(revisions);
        const protocol = { retainedResults: [...book.protocol.retainedResults] };
        expect(retainedResultsOf(protocol)).toBe(protocol.retainedResults);
      });

      test("a built state answers from its store with the length, the end and a map, and copies nothing", () => {
        const book = bookOf(4);
        const before = bookHistoryMaterializations();
        expect(journalsOf(book.state).length).toBe(4);
        expect(journalsOf(book.state).at(-1)?.journal.id as string).toBe("j4");
        expect(journalsOf(book.state).map((booked, position) => `${position}:${booked.journal.id}`)).toEqual(["0:j1", "1:j2", "2:j3", "3:j4"]);
        expect(revisionsOf(book.state).length).toBe(5);
        expect(revisionsOf(book.state).at(0)?.command.id as string).toBe("history-activate");
        expect(retainedResultsOf(book.protocol).length).toBe(5);
        expect(retainedResultsOf(book.protocol).at(-1)?.commandId as string).toBe("post-j4");
        expect(journalLogOf(book.state).filter((booked) => booked.journal.id !== "j2").map((booked) => booked.journal.id as string)).toEqual(["j1", "j3", "j4"]);
        expect(bookHistoryMaterializations()).toBe(before);
      });
    });
  });
}

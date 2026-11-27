/** A service opened with `replay: "trusted"` applies the revisions its ledger stored instead of executing every
 * command again, which is what makes a cold open of a large book fast. These tests hold that to account:
 *
 * - the oracle: on random books (postings, backdated postings, reversals, supersessions, closes, reopens, new
 *   accounts, calendar extensions, opening entries, refused commands, and two books that branch) the book and
 *   the protocol built by applying what a ledger would have stored are the ones the kernel's execution gives,
 *   at every step;
 * - the service: both modes read the same books and give the same journal lists, reports, balances and
 *   previews, a book without the state commitment is read in full, and `verify: "full"` always executes;
 * - the negative controls: a stored revision with a broken link, number, posting sequence or chain hash is
 *   refused by the trusted apply (and the read falls back to executing, which then names the defect), while
 *   a stored outcome with a changed amount is ACCEPTED by the trusted path, which is the design (the ledger's
 *   hash chain vouches for the stored bytes), and REJECTED by `verify: "full"`, which is the check. */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExactDecimal,
  applyRecordedOutcome,
  createBookProtocolState,
  createBookState,
  decodeBookOutcome,
  encodeBookOutcome,
  hashBookState,
  type BookOutcomePayload,
  type BookProtocolState,
  type BookState,
  type DurableBookAggregate,
  type RetainedCommandResult,
  type RevisionRecord,
} from "@rastrata/kernel";
import { buildBook } from "../bench/support/book.ts";
import { LocalBookService } from "../src/local.ts";
import { LedgerReplayError, type ReplayMode, type VerifiedView } from "../src/service.ts";
import { BULK_BOOK, postBulk, reverseBulk } from "./support/bulk-book.ts";
import { setupLegacyBook } from "./support/legacy-book.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { playRandomBook } from "./support/random-book.ts";
import { CHART } from "./support/scenario.ts";

const ASOF = "2026-12-31";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0).reverse()) work();
});

// ---------------------------------------------------------------- the oracle

const protocolOf = (book: KernelBook) =>
  (book as unknown as { protocol: BookProtocolState }).protocol;

/** The book as it stood before its first command, rebuilt from the first configuration snapshot it kept. */
function genesisOf(state: BookState): DurableBookAggregate {
  const first = state.configurationSnapshots[0] as BookState["configurationSnapshots"][number];
  return {
    state: createBookState(
      state.identity,
      first.periods,
      first.admissionSnapshot,
      first.policies,
      first.quantizationPolicies,
      first.accountingPolicySnapshot.policies,
      first.effectiveAt,
      first.executionProfile,
      first.stateCommitmentProfile,
    ),
    protocol: createBookProtocolState(),
  };
}

/** What a ledger stores of a retained result of `state`, decoded the way the application reads it back. */
function storedOutcome(state: BookState, retained: RetainedCommandResult): BookOutcomePayload {
  const committed = retained.outcome === "committed";
  const payload: BookOutcomePayload = {
    command: retained.command,
    revision: committed
      ? (state.revisions[Number(retained.observedBookRevision) - 1] as RevisionRecord)
      : null,
    originalResult: {
      disposition: retained.outcome,
      observedBookRevision: retained.observedBookRevision,
      resultHash: retained.resultHash,
      diagnostics: retained.diagnostics,
      completedAt: retained.completedAt,
      ...(committed ? { committedAt: retained.command.committedAt } : {}),
    },
  };
  const decoded = decodeBookOutcome(encodeBookOutcome(payload));
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  return decoded.payload;
}

interface Played {
  readonly steps: number;
  readonly operations: Map<string, number>;
  readonly final: DurableBookAggregate;
}

/** Play a random book, applying what a ledger would have stored of each command to a second book as it goes. */
function oracle(seed: number, steps: number, sources: boolean): Played {
  let trusted: DurableBookAggregate | null = null;
  let seen = 0;
  let applied = 0;
  const operations = new Map<string, number>();
  const book = playRandomBook({
    seed,
    steps,
    sources,
    onState: (visit, kernelBook) => {
      const protocol = protocolOf(kernelBook);
      const retained = protocol.retainedResults;
      let current: DurableBookAggregate = trusted ?? genesisOf(visit.state);
      for (const result of retained.slice(seen)) {
        const next = applyRecordedOutcome(
          current.state,
          current.protocol,
          storedOutcome(visit.state, result),
        );
        if (next.disposition !== "applied")
          throw new Error(`seed ${seed} step ${visit.step}: ${JSON.stringify(next.diagnostics)}`);
        current = { state: next.state, protocol: next.protocol };
        applied += 1;
      }
      seen = retained.length;
      trusted = current;
      expect(current.state, `seed ${seed} step ${visit.step} (${visit.operation})`).toEqual(
        visit.state,
      );
      expect(current.protocol, `seed ${seed} step ${visit.step} protocol`).toEqual(protocol);
      expect(current.state.contentHash).toEqual(visit.state.contentHash);
      expect(hashBookState(current.state)).toEqual(visit.state.contentHash);
      if (visit.committed)
        operations.set(visit.operation, (operations.get(visit.operation) ?? 0) + 1);
    },
  });
  expect(trusted).not.toBeNull();
  const final = trusted as unknown as DurableBookAggregate;
  expect(final.state.bookRevision).toBe(book.state.bookRevision);
  return { steps: applied, operations, final };
}

describe("applying what a ledger stored gives the book the kernel's execution gives", () => {
  const seeds = [3, 17, 41, 75, 91, 112, 205, 318];
  const all = new Map<string, number>();
  for (const seed of seeds) {
    test(`at every step of a random book, seed ${seed}`, () => {
      const played = oracle(seed, 110, seed % 2 === 0);
      expect(played.steps).toBeGreaterThan(60);
      for (const [operation, count] of played.operations)
        all.set(operation, (all.get(operation) ?? 0) + count);
    });
  }

  test("and the books together did every kind of thing a book is asked to do", () => {
    for (const operation of [
      "post",
      "reverse",
      "supersede",
      "close",
      "reopen",
      "account",
      "extend",
      "opening",
    ])
      expect(all.get(operation) ?? 0, operation).toBeGreaterThan(0);
  });

  test("with refused commands retained between the committed ones", () => {
    const played = oracle(13, 140, false);
    const refused = played.final.protocol.retainedResults.filter(
      (retained) => retained.outcome === "rejected",
    );
    expect(refused.length).toBeGreaterThan(5);
    expect(played.final.state.bookRevision).toBeGreaterThan(100n);
  });

  test("for two books that branch from one point, each branch the one its own commands make", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    const ids = [1, 2, 3, 4].map((day) =>
      book.post(`2025-03-0${day}`, [
        ["1000", BigInt(day) * 100n],
        ["4000", -BigInt(day) * 100n],
      ]),
    );
    const base = book.state;
    const baseProtocol = protocolOf(book);
    const other = book.fork();
    book.post("2025-03-10", [
      ["1000", 7n],
      ["4000", -7n],
    ]);
    book.reverse(ids[1] as string, "2025-03-11");
    other.reverse(ids[2] as string, "2025-03-12");
    other.post("2025-03-13", [
      ["6000", 9n],
      ["1000", -9n],
    ]);
    // The start both branches share: everything up to the fork, applied once.
    let start: DurableBookAggregate = genesisOf(base);
    for (const result of baseProtocol.retainedResults) {
      const next = applyRecordedOutcome(start.state, start.protocol, storedOutcome(base, result));
      if (next.disposition !== "applied") throw new Error(JSON.stringify(next.diagnostics));
      start = { state: next.state, protocol: next.protocol };
    }
    expect(start.state).toEqual(base);
    const branches = [book, other].map((branch) => {
      let current = start;
      for (const result of protocolOf(branch).retainedResults.slice(
        baseProtocol.retainedResults.length,
      )) {
        const next = applyRecordedOutcome(
          current.state,
          current.protocol,
          storedOutcome(branch.state, result),
        );
        if (next.disposition !== "applied") throw new Error(JSON.stringify(next.diagnostics));
        current = { state: next.state, protocol: next.protocol };
      }
      return current;
    });
    const [left, right] = branches as [DurableBookAggregate, DurableBookAggregate];
    expect(left.state).toEqual(book.state);
    expect(right.state).toEqual(other.state);
    expect(left.protocol).toEqual(protocolOf(book));
    expect(right.protocol).toEqual(protocolOf(other));
    expect(left.state.contentHash).not.toEqual(right.state.contentHash);
    // Neither branch leaked into the other, nor into the book they share.
    expect(start.state.revisions).toHaveLength(base.revisions.length);
    expect(left.state.revisions).toHaveLength(base.revisions.length + 2);
    expect(right.state.revisions).toHaveLength(base.revisions.length + 2);
  });
});

// ---------------------------------------------------------------- the service

/** A book file with this many journals, some reversed, written by a service that is then closed. */
async function writtenBook(journals: number, reversed = 0, legacy = false): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rastrata-replay-trusted-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "book.sqlite");
  const writer = await LocalBookService.open(path, { snapshots: false });
  if (legacy) await setupLegacyBook(writer);
  else await writer.setup(BULK_BOOK);
  const ids = await postBulk(writer, journals);
  if (reversed > 0)
    await reverseBulk(writer, ids.filter((_, index) => index % 5 === 2).slice(0, reversed));
  writer.close();
  return path;
}

async function opened(
  path: string,
  replay: ReplayMode,
  snapshots = false,
  behind: {
    readonly verifyBehind?: boolean;
    readonly view?: VerifiedView | null;
    readonly verifying?: Promise<void> | null;
  } = {},
): Promise<LocalBookService> {
  const service = await LocalBookService.open(path, { snapshots, replay, ...behind });
  // A test closes a service to see what it leaves behind; the cleanup must not close it again.
  const close = service.close.bind(service);
  let closed = false;
  service.close = () => {
    if (!closed) close();
    closed = true;
  };
  cleanup.push(() => service.close());
  return service;
}

describe("a service opened with replay trusted", () => {
  test("reads a book as one opened in full does: the same book, journal lists, reports, balances and periods", async () => {
    const path = await writtenBook(75, 8);
    const full = await opened(path, "full");
    const trusted = await opened(path, "trusted");
    const fullBook = (await full.readAggregate()).aggregate;
    const trustedBook = (await trusted.readAggregate()).aggregate;
    expect(trusted.readStats).toMatchObject({ full: 1, trusted: 84, verified: 0, fallbacks: 0 });
    expect(full.readStats).toMatchObject({ full: 1, trusted: 0, verified: 84, fallbacks: 0 });
    expect(trustedBook.state).toEqual(fullBook.state);
    expect(trustedBook.protocol).toEqual(fullBook.protocol);
    expect(trustedBook.state.contentHash).toEqual(fullBook.state.contentHash);
    expect(trustedBook.state.journals).toHaveLength(83);
    expect(await trusted.reports(ASOF)).toEqual(await full.reports(ASOF));
    expect(await trusted.accounts(ASOF)).toEqual(await full.accounts(ASOF));
    expect(await trusted.periods()).toEqual(await full.periods());
    for (const query of [
      { page: 1, text: "", from: "", to: "", accountId: "", status: "" },
      { page: 2, text: "", from: "", to: "", accountId: "", status: "" },
      { page: 1, text: "entry", from: "2026-03-01", to: "2026-06-30", accountId: "", status: "" },
    ])
      expect(await trusted.journalBook(query)).toEqual(await full.journalBook(query));
    // A historical revision is read the same way.
    expect((await trusted.readAggregate(40n)).aggregate.state).toEqual(
      (await full.readAggregate(40n)).aggregate.state,
    );
  });

  test("reads a book with a realistic chart and configuration revisions as one in full does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rastrata-replay-trusted-chart-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "book.sqlite");
    await buildBook({ path, journals: 60, accounts: 40, revisions: 4, spread: true, seed: 7 });
    const full = await opened(path, "full");
    const trusted = await opened(path, "trusted");
    const fullBook = (await full.readAggregate()).aggregate;
    const trustedBook = (await trusted.readAggregate()).aggregate;
    expect(trustedBook.state.configurationSnapshots).toHaveLength(5);
    expect(trustedBook.state.admissionSnapshot.accounts).toHaveLength(40);
    expect(trusted.readStats).toMatchObject({ trusted: 65, verified: 0, fallbacks: 0 });
    expect(trustedBook.state).toEqual(fullBook.state);
    expect(trustedBook.protocol).toEqual(fullBook.protocol);
    expect(await trusted.reports(ASOF)).toEqual(await full.reports(ASOF));
    expect(await trusted.accounts(ASOF)).toEqual(await full.accounts(ASOF));
  });

  test("takes writes after a trusted open: a posting and a reversal go through, and a full service reads the same book", async () => {
    const path = await writtenBook(25, 2);
    const trusted = await opened(path, "trusted");
    const before = (await trusted.readAggregate()).aggregate.state;
    const draft = trusted.createDraft({
      date: "2026-03-05",
      reference: "AFTER-TRUSTED",
      narration: "Posted after a trusted open",
      lines: [
        { accountId: "1000", debit: "75.00", credit: "" },
        { accountId: "4000", debit: "", credit: "75.00" },
      ],
    });
    expect((await trusted.postDraft(draft.id)).disposition).toBe("committed");
    const posted = (await trusted.readAggregate()).aggregate.state;
    expect(posted.journals).toHaveLength(before.journals.length + 1);
    const original = posted.journals[posted.journals.length - 1] as { journal: { id: string } };
    const reversal = await trusted.reverseJournal({
      actionId: crypto.randomUUID(),
      journalId: original.journal.id,
      accountingDate: "2026-03-06",
      reason: "Reversed after a trusted open",
    });
    expect(reversal.disposition).toBe("committed");
    const after = (await trusted.readAggregate()).aggregate.state;
    expect(after.journals).toHaveLength(before.journals.length + 2);
    expect(trusted.readStats).toMatchObject({ fallbacks: 0, verified: 0 });
    const full = await opened(path, "full");
    expect((await full.readAggregate()).aggregate.state).toEqual(after);
    // The independent check of the trusted service passes on a book it has only added honest entries to.
    await trusted.readAggregate(undefined, { verify: "full" });
  });

  test("goes on from what it read: a posting afterwards is read the same by a service that opens later", async () => {
    const path = await writtenBook(30, 3);
    const first = await opened(path, "trusted");
    await first.readAggregate();
    await postBulk(first, 5);
    expect((await first.readAggregate()).aggregate.state.journals).toHaveLength(38);
    expect(first.readStats.trusted).toBeGreaterThan(30);
    first.close();
    const later = await opened(path, "trusted");
    const full = await opened(path, "full");
    expect((await later.readAggregate()).aggregate.state).toEqual(
      (await full.readAggregate()).aggregate.state,
    );
  });

  test("previews a retried command as one opened in full does, from the protocol it rebuilt", async () => {
    const path = await writtenBook(12);
    const writer = await opened(path, "full");
    const draft = writer.createDraft({
      date: "2026-02-10",
      reference: "REPLAY-1",
      narration: "Posted once",
      lines: [
        { accountId: "1000", debit: "50.00", credit: "" },
        { accountId: "4000", debit: "", credit: "50.00" },
      ],
    });
    const operationId = crypto.randomUUID();
    const prepared = await writer.prepareDraft(draft.id, draft.version, operationId);
    expect(prepared.valid).toBe(true);
    expect((await writer.commitAction(operationId, prepared.planHash ?? "")).disposition).toBe(
      "committed",
    );
    writer.close();
    const seen: unknown[] = [];
    for (const mode of ["full", "trusted"] as const) {
      const service = await opened(path, mode);
      // The command is retained now: the kernel answers it "replayed" and does not run it again.
      seen.push(await service.prepareDraft(draft.id, draft.version, operationId));
    }
    expect(seen[1]).toEqual(seen[0]);
    expect((seen[0] as { valid: boolean }).valid).toBe(false);
    expect((seen[0] as { problems: unknown[] }).problems).toEqual([]);
  });

  test("reads a book made without the state commitment in full, and says so", async () => {
    const path = await writtenBook(20, 2, true);
    const trusted = await opened(path, "trusted");
    const full = await opened(path, "full");
    const fullBook = (await full.readAggregate()).aggregate;
    const trustedBook = (await trusted.readAggregate()).aggregate;
    expect(trustedBook.state.activeConfigurationSnapshot.stateCommitmentProfile).toBeUndefined();
    expect(trusted.readStats).toMatchObject({ full: 1, trusted: 0, verified: 23, fallbacks: 1 });
    expect(trustedBook.state).toEqual(fullBook.state);
    expect(await trusted.reports(ASOF)).toEqual(await full.reports(ASOF));
  });

  test("always executes when asked to verify, and the result is the verified state afterwards", async () => {
    const path = await writtenBook(40, 4);
    const service = await opened(path, "trusted");
    const trustedBook = (await service.readAggregate()).aggregate;
    expect(service.readStats).toMatchObject({ trusted: 45, verified: 0 });
    const verified = (await service.readAggregate(undefined, { verify: "full" })).aggregate;
    expect(service.readStats).toMatchObject({ full: 2, trusted: 45, verified: 45, fallbacks: 0 });
    expect(verified.state).toEqual(trustedBook.state);
    expect(verified.protocol).toEqual(trustedBook.protocol);
    // Reading again continues from the verified view and executes nothing more.
    await service.readAggregate();
    expect(service.readStats).toMatchObject({ full: 2, trusted: 45, verified: 45 });
  });

  test("saves no read snapshot, though it loads one a service in full saved", async () => {
    const path = await writtenBook(30, 0);
    const trusted = await opened(path, "trusted", true);
    await trusted.readAggregate();
    await postBulk(trusted, 120);
    await trusted.readAggregate();
    trusted.close();
    expect(trusted.readStats.snapshotsWritten).toBe(0);
    // Nothing was saved, so a service in full that opens next replays the whole book.
    const writer = await opened(path, "full", true);
    await writer.readAggregate();
    expect(writer.readStats).toMatchObject({ snapshot: 0, full: 1, verified: 151 });
    writer.close();
    // It saved one as it closed. Eight more outcomes arrive from a service that keeps none.
    const later = await opened(path, "full", false);
    await postBulk(later, 8);
    later.close();
    const restored = await opened(path, "trusted", true);
    const book = (await restored.readAggregate()).aggregate;
    expect(restored.readStats).toMatchObject({ snapshot: 1, full: 0, trusted: 8, verified: 0 });
    expect(book.state.journals).toHaveLength(158);
    const full = await opened(path, "full", false);
    expect((await full.readAggregate()).aggregate.state).toEqual(book.state);
  });
});

// ---------------------------------------------------------------- the negative controls

type Page = Awaited<ReturnType<LocalBookService["outcomePage"]>>;

/** Make the ledger answer with one stored outcome changed, as a damaged store whose chain was made good again would. */
function damage(
  service: LocalBookService,
  target: (payload: BookOutcomePayload, sequence: number) => boolean,
  change: (payload: BookOutcomePayload) => BookOutcomePayload,
): { changed: () => number } {
  const ledger = service.ledger as unknown as { outcomes: (...args: unknown[]) => Promise<Page> };
  const original = ledger.outcomes.bind(ledger);
  let changed = 0;
  ledger.outcomes = async (...args: unknown[]) => {
    const page = await original(...args);
    return {
      ...page,
      outcomes: page.outcomes.map((outcome) => {
        if (!target(outcome.payload, Number(outcome.head.sequence))) return outcome;
        changed += 1;
        const encoded = encodeBookOutcome(change(outcome.payload));
        const decoded = decodeBookOutcome(encoded);
        if (decoded.disposition !== "decoded") throw new Error(decoded.message);
        return { ...outcome, encoded, payload: decoded.payload };
      }),
    };
  };
  return { changed: () => changed };
}

/** The outcome with sequence 22, the twenty-first journal of the book. */
const aPosting = (payload: BookOutcomePayload, sequence: number) =>
  sequence === 22 && payload.revision?.effects.some((effect) => effect.type === "journal") === true;

const withRevision = (
  payload: BookOutcomePayload,
  change: Partial<RevisionRecord>,
  result: Partial<BookOutcomePayload["originalResult"]> = {},
): BookOutcomePayload => ({
  ...payload,
  revision: Object.freeze({ ...(payload.revision as RevisionRecord), ...change }),
  originalResult: Object.freeze({ ...payload.originalResult, ...result }),
});

/** The first line of the journal this outcome booked, 9,999.99 where it said something else. */
const raised = (payload: BookOutcomePayload): BookOutcomePayload => {
  const revision = payload.revision as RevisionRecord;
  return {
    ...payload,
    revision: Object.freeze({
      ...revision,
      effects: Object.freeze(
        revision.effects.map((effect) => {
          if (effect.type !== "journal") return effect;
          const [first, ...rest] = effect.booked.journal.postings;
          const firstLine = first as (typeof effect.booked.journal.postings)[number];
          const line = Object.freeze({
            ...firstLine,
            bookValue: Object.freeze({
              ...firstLine.bookValue,
              amount: ExactDecimal.of(999_999n, 2n),
            }),
          });
          const journal = Object.freeze({
            ...effect.booked.journal,
            postings: Object.freeze([line, ...rest]),
          });
          return Object.freeze({
            ...effect,
            booked: Object.freeze({ ...effect.booked, journal }),
          });
        }),
      ),
    }),
  };
};

describe("what a trusted read checks and what it trusts", () => {
  test("a stored outcome with a changed amount is accepted by the trusted path and rejected by a full verification", async () => {
    const path = await writtenBook(40, 0);
    const trusted = await opened(path, "trusted");
    const control = damage(trusted, aPosting, raised);
    // Trusted: the changed revision is applied, as the design says. The book now holds a journal that its command never made.
    const book = (await trusted.readAggregate()).aggregate;
    expect(control.changed()).toBe(1);
    expect(trusted.readStats).toMatchObject({ trusted: 41, verified: 0, fallbacks: 0 });
    expect(
      book.state.journals.some(
        (booked) => booked.journal.postings[0]?.bookValue.amount.toString() === "9999.99",
      ),
    ).toBe(true);
    // The check: executing every outcome against the ledger's record of it says that this one is not what its command makes.
    await expect(trusted.readAggregate(undefined, { verify: "full" })).rejects.toThrow(
      "Book outcome does not match its kernel result",
    );
    // A service in the default mode that reads the same store refuses it the first time it reads.
    const full = await opened(path, "full");
    damage(full, aPosting, raised);
    await expect(full.readAggregate()).rejects.toThrow(
      "Book outcome does not match its kernel result",
    );
  });

  const broken: [string, (payload: BookOutcomePayload) => BookOutcomePayload][] = [
    [
      "a broken link to the previous chain hash",
      (payload) =>
        withRevision(payload, {
          previousHash: {
            ...(payload.revision as RevisionRecord).chainHash,
            digest: "0".repeat(64),
          },
        }),
    ],
    [
      "a revision number that is not the next",
      (payload) =>
        withRevision(
          payload,
          { bookRevision: (payload.revision as RevisionRecord).bookRevision + 1n },
          { observedBookRevision: payload.originalResult.observedBookRevision + 1n },
        ),
    ],
    [
      "a posting sequence that skips",
      (payload) =>
        withRevision(payload, {
          effects: Object.freeze(
            (payload.revision as RevisionRecord).effects.map((effect) =>
              effect.type === "journal"
                ? Object.freeze({
                    ...effect,
                    booked: Object.freeze({
                      ...effect.booked,
                      postingSequence: effect.booked.postingSequence + 3n,
                    }),
                  })
                : effect,
            ),
          ),
        }),
    ],
    [
      "a chain hash that is not the hash of its link and its effects hash",
      (payload) =>
        withRevision(payload, {
          chainHash: { ...(payload.revision as RevisionRecord).chainHash, digest: "f".repeat(64) },
        }),
    ],
  ];
  for (const [name, change] of broken) {
    test(`${name} is refused by the trusted apply, and the read is made in full, which reports the defect`, async () => {
      const path = await writtenBook(40, 0);
      const trusted = await opened(path, "trusted");
      const control = damage(trusted, aPosting, change);
      await expect(trusted.readAggregate()).rejects.toThrow(
        "Book outcome does not match its kernel result",
      );
      expect(control.changed()).toBeGreaterThanOrEqual(2);
      expect(trusted.readStats.fallbacks).toBe(1);
      expect(trusted.readStats.trusted).toBeGreaterThan(15);
      expect(trusted.readStats.verified).toBeGreaterThan(15);
    });
  }

  test("a trusted service whose store is intact falls back to nothing", async () => {
    const path = await writtenBook(25, 2);
    const copy = join(mkdtempSync(join(tmpdir(), "rastrata-replay-trusted-copy-")), "copy.sqlite");
    cleanup.push(() => rmSync(join(copy, ".."), { recursive: true, force: true }));
    cpSync(path, copy);
    const trusted = await opened(copy, "trusted");
    await trusted.readAggregate();
    expect(trusted.readStats).toMatchObject({ fallbacks: 0, verified: 0, trusted: 28 });
  });
});

// ---------------------------------------------------------------- how the pages are decoded

type Decoding = Parameters<LocalBookService["ledger"]["outcomes"]>[3];

/** Record the decoding each page request of a service names. */
function watchingDecoding(service: LocalBookService): Decoding[] {
  const asked: Decoding[] = [];
  const ledger = service.ledger as unknown as { outcomes: (...args: unknown[]) => Promise<Page> };
  const original = ledger.outcomes.bind(ledger);
  ledger.outcomes = (...args: unknown[]) => {
    asked.push(args[3] as Decoding);
    return original(...args);
  };
  return asked;
}

describe("the decoding of the pages a read asks the ledger for", () => {
  test("a trusted read skips the proof that each stored text is canonical, and so does a trusted service's fallback", async () => {
    const path = await writtenBook(40, 0);
    const trusted = await opened(path, "trusted");
    const asked = watchingDecoding(trusted);
    await trusted.readAggregate();
    expect(asked.length).toBeGreaterThan(2);
    expect(new Set(asked)).toEqual(new Set(["stored"]));
    const legacy = await opened(await writtenBook(10, 0, true), "trusted");
    const legacyAsked = watchingDecoding(legacy);
    await legacy.readAggregate();
    expect(legacy.readStats.fallbacks).toBe(1);
    expect(new Set(legacyAsked)).toEqual(new Set(["stored"]));
  });

  test("a full verification keeps the canonical decode, and a service in the default mode skips the proof because comparing what it executed with the text says as much", async () => {
    const path = await writtenBook(40, 0);
    const trusted = await opened(path, "trusted");
    const asked = watchingDecoding(trusted);
    await trusted.readAggregate(undefined, { verify: "full" });
    expect(asked.length).toBeGreaterThan(2);
    expect(new Set(asked)).toEqual(new Set([undefined]));
    // The default mode asks for the stored decode: a read in full compares the encoding of every outcome it executed with the stored text byte for byte, so a text that is not the
    // canonical encoding of its payload is refused by that comparison, and the ledger's proof of it is the third of a replay's cost spent on saying it twice.
    const full = await opened(path, "full");
    const fullAsked = watchingDecoding(full);
    await full.readAggregate();
    expect(fullAsked.length).toBeGreaterThan(2);
    expect(new Set(fullAsked)).toEqual(new Set(["stored"]));
    expect(full.readStats).toMatchObject({ verified: 41, trusted: 0 });
    // Its own full verification is the strictest there is, as before.
    const strict = await opened(path, "full");
    const strictAsked = watchingDecoding(strict);
    await strict.readAggregate(undefined, { verify: "full" });
    expect(new Set(strictAsked)).toEqual(new Set([undefined]));
  });

  test("the ledger gives the same pages either way, whole, through its authorized port", async () => {
    const path = await writtenBook(30, 3);
    const service = await opened(path, "full");
    const credential = await (
      service as unknown as { credential: () => Promise<never> }
    ).credential();
    let canonical = await service.ledger.outcomes(credential, null, 16);
    let stored = await service.ledger.outcomes(credential, null, 16, "stored");
    let pages = 0;
    for (;;) {
      pages += 1;
      expect(stored).toEqual(canonical);
      expect(stored.outcomes.length).toBeGreaterThan(0);
      if (canonical.through.sequence === canonical.observedTip.sequence) break;
      canonical = await service.ledger.outcomes(credential, canonical.through, 16);
      stored = await service.ledger.outcomes(credential, stored.through, 16, "stored");
    }
    expect(pages).toBe(3);
  });
});

// ---------------------------------------------------------------- the check behind the first answer

describe("a service that checks the ledger behind its first answer", () => {
  /** The outcomes of a book as written by `writtenBook(journals, reversed)`: its setup, each journal and each reversal. */
  const outcomes = (service: LocalBookService) => service.readStats.trusted;

  /** What a store that did not answer does to the check: the call of the ledger that follows the ones a trusted read makes fails once. */
  function failingTheCheck(
    service: LocalBookService,
    afterCalls: number,
  ): { failed: () => boolean } {
    const ledger = service.ledger as unknown as { outcomes: (...args: unknown[]) => Promise<Page> };
    const original = ledger.outcomes.bind(ledger);
    let calls = 0;
    let failed = false;
    ledger.outcomes = async (...args: unknown[]) => {
      calls += 1;
      if (calls === afterCalls + 1 && !failed) {
        failed = true;
        throw new Error("The store did not answer");
      }
      return original(...args);
    };
    return { failed: () => failed };
  }

  /** How many times the ledger has been asked for a page of outcomes, and what to do just before the next ask. */
  function watchingPages(
    service: LocalBookService,
    before: (call: number) => Promise<void> = async () => {},
  ): () => number {
    const ledger = service.ledger as unknown as { outcomes: (...args: unknown[]) => Promise<Page> };
    const original = ledger.outcomes.bind(ledger);
    let calls = 0;
    ledger.outcomes = async (...args: unknown[]) => {
      calls += 1;
      await before(calls);
      return original(...args);
    };
    return () => calls;
  }

  test("the first read applies the stored revisions, and the check then executes every outcome against what the ledger stored, page after page", async () => {
    const path = await writtenBook(300, 20);
    const service = await opened(path, "full", false, { verifyBehind: true });
    const pages = watchingPages(service);
    expect(service.verification()).toBeNull();
    await service.readAggregate();
    const readPages = pages();
    // The answer was given from the stored revisions, nothing executed yet: that is the time it saves.
    expect(service.readStats).toMatchObject({ verified: 0, fallbacks: 0 });
    expect(outcomes(service)).toBeGreaterThan(300);
    const check = service.verification();
    expect(check).not.toBeNull();
    await check;
    // Every outcome was executed, byte for byte against its record, as a service in `full` mode does before it answers, and not only the first page of them.
    expect(pages() - readPages).toBeGreaterThan(1);
    expect(service.readStats.verified).toBe(outcomes(service));
    const full = await opened(path, "full");
    await full.readAggregate();
    expect(service.readStats.verified).toBe(full.readStats.verified);
  });

  test("a service that is not asked to check behind its answers has nothing to wait for, and one that is reads the book and waits", async () => {
    const path = await writtenBook(30, 2);
    const plain = await opened(path, "full");
    await plain.ensureVerified();
    expect(plain.readStats).toMatchObject({ full: 0, incremental: 0, verified: 0 });
    expect(plain.verification()).toBeNull();

    const behind = await opened(path, "full", false, { verifyBehind: true });
    await behind.ensureVerified();
    expect(behind.readStats).toMatchObject({ full: 1, fallbacks: 0 });
    expect(behind.readStats.verified).toBe(outcomes(behind));
    // Asked again, it has nothing more to wait for.
    await behind.ensureVerified();
    expect(behind.readStats.full).toBe(1);

    // A service that is trusted and not checking behind (the verifier is its check) has no check of its own.
    const trusted = await opened(path, "trusted");
    await trusted.ensureVerified();
    expect(trusted.verification()).toBeNull();
  });

  test("a stored outcome that its command does not make is read, as the design says, and the check then fails with the ledger's own error, and keeps failing", async () => {
    const path = await writtenBook(40, 0);
    const service = await opened(path, "full", false, { verifyBehind: true });
    const control = damage(service, aPosting, raised);
    const book = (await service.readAggregate()).aggregate;
    expect(control.changed()).toBeGreaterThanOrEqual(1);
    expect(
      book.state.journals.some(
        (booked) => booked.journal.postings[0]?.bookValue.amount.toString() === "9999.99",
      ),
    ).toBe(true);
    const check = service.verification();
    await expect(check).rejects.toBeInstanceOf(LedgerReplayError);
    await expect(check).rejects.toThrow("Book outcome does not match its kernel result");
    // A write that waits for the check is refused by it, every time: no command is run on a book that does not replay.
    await expect(service.ensureVerified()).rejects.toBeInstanceOf(LedgerReplayError);
    await expect(service.ensureVerified()).rejects.toBeInstanceOf(LedgerReplayError);
    expect(service.verification()).toBe(check);
  });

  test("a check that fails for a reason that is not the book's is forgotten, and the next write makes it again", async () => {
    const path = await writtenBook(30, 0);
    const probe = await opened(path, "trusted");
    let reads = 0;
    const counted = probe.ledger as unknown as { outcomes: (...args: unknown[]) => Promise<Page> };
    const counting = counted.outcomes.bind(counted);
    counted.outcomes = async (...args: unknown[]) => {
      reads += 1;
      return counting(...args);
    };
    await probe.readAggregate();

    const service = await opened(path, "full", false, { verifyBehind: true });
    const trouble = failingTheCheck(service, reads);
    await service.readAggregate();
    const check = service.verification();
    await expect(check).rejects.toThrow("The store did not answer");
    expect(trouble.failed()).toBe(true);
    // Not the book's fault, so nothing is held against it: the next write asks again and the check runs to its end.
    await service.ensureVerified();
    expect(service.readStats.verified).toBe(outcomes(service));
    expect(service.verification()).not.toBe(check);
  });

  test("a book that grows while the check reads it does not stop the check, which goes on to the end of what it set out to read", async () => {
    const path = await writtenBook(300, 0);
    const other = await opened(path, "full");
    await other.readAggregate();
    // The pages a trusted read of this book asks for, so that the check's own can be told from them.
    const probe = await opened(path, "trusted");
    const probed = watchingPages(probe);
    await probe.readAggregate();
    const readPages = probed();
    const service = await opened(path, "full", false, { verifyBehind: true });
    let grown = false;
    watchingPages(service, async (call) => {
      // The second page the check asks for: the book has three journals more than when it began.
      if (call === readPages + 2 && !grown) {
        grown = true;
        await postBulk(other, 3);
      }
    });
    await service.readAggregate();
    await service.verification();
    expect(grown).toBe(true);
    expect(service.readStats.verified).toBeGreaterThanOrEqual(outcomes(service));
    // The three are the next read's: it executes them, as a service in `full` mode does.
    const verifiedBefore = service.readStats.verified;
    await service.readAggregate();
    expect(service.readStats.verified).toBeGreaterThan(verifiedBefore - 1);
    const fresh = await opened(path, "full");
    expect((await service.readAggregate()).aggregate.state).toEqual(
      (await fresh.readAggregate()).aggregate.state,
    );
  });

  test("what is added to a book it has read is executed as it is read, and no outcome is trusted that nothing would execute", async () => {
    const path = await writtenBook(30, 0);
    const service = await opened(path, "full", false, { verifyBehind: true });
    await service.readAggregate();
    await service.verification();
    const before = { ...service.readStats };
    // Another process writes three journals.
    const other = await opened(path, "full");
    await postBulk(other, 3);
    other.close();
    await service.readAggregate();
    expect(service.readStats.incremental).toBe(before.incremental + 1);
    expect(service.readStats.verified - before.verified).toBe(3);
    expect(service.readStats.trusted).toBe(before.trusted);
    // And it is the book a read from the first entry gives.
    const fresh = await opened(path, "full");
    expect((await service.readAggregate()).aggregate.state).toEqual(
      (await fresh.readAggregate()).aggregate.state,
    );
  });

  test("a service made when the log is caught up begins from the view and the check of the one before, and a write on it waits for that check", async () => {
    const path = await writtenBook(30, 0);
    const first = await opened(path, "full", false, { verifyBehind: true });
    await first.readAggregate();
    const view = first.verifiedView();
    const verifying = first.verification();
    expect(view).not.toBeNull();
    expect(verifying).not.toBeNull();
    const second = await opened(path, "full", false, { verifyBehind: true, view, verifying });
    expect(second.verification()).toBe(verifying);
    await second.ensureVerified();
    await second.readAggregate();
    expect(second.readStats).toMatchObject({ full: 0, incremental: 1, trusted: 0 });

    // A check that failed is carried on and refuses the writes of the service that replaces the one that found it.
    const damaged = await opened(path, "full", false, { verifyBehind: true });
    damage(damaged, aPosting, raised);
    await damaged.readAggregate();
    const failed = damaged.verification() as Promise<void>;
    await failed.catch(() => {});
    const next = await opened(path, "full", false, {
      verifyBehind: true,
      view: damaged.verifiedView(),
      verifying: failed,
    });
    await expect(next.ensureVerified()).rejects.toBeInstanceOf(LedgerReplayError);
  });

  test("a view the ledger does not continue from is dropped with its check, and the book it reads instead has a check of its own", async () => {
    const mine = await writtenBook(25, 0);
    const theirs = await writtenBook(35, 0);
    const stranger = await opened(theirs, "full", false, { verifyBehind: true });
    await stranger.readAggregate();
    const carried = stranger.verification() as Promise<void>;
    await carried;
    const service = await opened(mine, "full", false, {
      verifyBehind: true,
      view: stranger.verifiedView(),
      verifying: carried,
    });
    await service.readAggregate();
    expect(service.readStats).toMatchObject({ full: 1, incremental: 0 });
    const own = service.verification();
    expect(own).not.toBe(carried);
    await own;
    expect(service.readStats.verified).toBe(outcomes(service));
  });

  test("the checks of a process run one at a time", async () => {
    const long = await writtenBook(300, 0);
    const short = await writtenBook(20, 0);
    const a = await opened(long, "full", false, { verifyBehind: true });
    const b = await opened(short, "full", false, { verifyBehind: true });
    await a.readAggregate();
    await b.readAggregate();
    const checks = [a.verification(), b.verification()] as [Promise<void>, Promise<void>];
    let aDone = false;
    checks[0].then(() => {
      aDone = true;
    });
    let overlapped = false;
    let slices = 0;
    while (!aDone) {
      slices += 1;
      if (b.readStats.verified > 0) overlapped = true;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(slices).toBeGreaterThan(1);
    expect(overlapped).toBe(false);
    await checks[1];
    expect(b.readStats.verified).toBe(outcomes(b));
  });
});

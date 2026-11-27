import {
  compileCoreReports,
  configurationAt,
  reportingWindow,
  type ReportOptions,
} from "./reports.ts";
import { accountActivity, verifyPopulation } from "./reports/activity.ts";
import { bookView, ledgerView } from "./reports/ledger.ts";
import { linksOf } from "./reports/ledger-links.ts";
import {
  ProjectionTrack,
  projectionDisagreement,
  vouchProjection,
} from "./reports/ledger-projection.ts";
import {
  CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  accountId,
  actorId,
  applyRecordedOutcome,
  bookId,
  commandId,
  commodityId,
  createBookProtocolState,
  createBookState,
  decodeBookCommand,
  decodeDurableBook,
  derivationId,
  encodeBookCommand,
  encodeBookOutcome,
  encodeDurableBook,
  evidenceId,
  executeBookCommand,
  ExactDecimal,
  ExactRational,
  fiscalCalendarId,
  hashCanonical,
  identifier,
  instant,
  journalId,
  latestRetainedCommandResult,
  latestRevisionRecord,
  localDate,
  openingBoundaryId,
  policyCapabilityId,
  policyId,
  postingId,
  quantizationPolicyId,
  resolveJournal,
  sealCommand,
  semanticVersion,
  type AccountSnapshot,
  type BookCommand,
  type BookState,
  type CanonicalValue,
  type BookingPolicy,
  type DurableBookAggregate,
  type JournalTransaction,
  type QuantizationPolicy,
  type ResolvedTransaction,
  type RevisionRecord,
  type BookedJournal,
} from "@rastrata/kernel";
import type { BookApplicationService, BookCredential, CompleteBookScope } from "@rastrata/ledger";
import type {
  BookSetup,
  JournalDraftData,
  SourceEvent,
  SavedDraft,
  MutationReceipt,
  PreparedOperation,
} from "./contracts.ts";
import { ApplicationError } from "./errors.ts";
import { JOURNAL_PAGE_SIZE, journalBookPage } from "./journal-book.ts";
import { fiscalYearBounds, isBasis, isDate, isStartMonth } from "./calendar/fiscal-calendar.ts";
import { calendarCoverage, kernelFiscalYear } from "./calendar/kernel-calendar.ts";
import {
  closePeriodCommand,
  extendCalendarCommand,
  reopenPeriodCommand,
} from "./calendar/commands.ts";
import { calendarCovers, requireCalendarDate } from "./calendar/errors.ts";
import {
  MAX_EXTENSION_YEARS,
  extendThroughFor,
  fiscalYearRange,
  planExtension,
} from "./calendar/extend.ts";
import { periodList } from "./calendar/periods.ts";
import { explainProblems } from "./calendar/problems.ts";
import { calendarMonthOf, ledgerShape, monthOfPeriods } from "./calendar/year-start.ts";
import { booksBeganOn, postingFloor } from "./slices/shadow/cutover-date.ts";
import {
  calendarEndYear,
  calendarShape,
  calendarThroughFor,
  resolveSetup,
  sameSetup,
  type ResolvedSetup,
} from "./calendar/setup.ts";
import { readAccountTags } from "./account-tags.ts";
import { adviseOnPlan } from "./slices/advisors.ts";
import { changesState, type Committer } from "./slices/changes/store.ts";
import { validateChartTags } from "./chart/tags.ts";
import type { ApplicationHost } from "./host.ts";

// JSON transports safe integer counts/years; kernel canonical hashing represents
// integers as bigint and deliberately refuses floating-point numbers.
function requestCanonical(value: unknown): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(requestCanonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, requestCanonical(member)]),
    );
  throw new TypeError("Unsupported request value");
}
import type { ApplicationStore } from "./storage.ts";

type NativeLedgerHead = Awaited<ReturnType<BookApplicationService["outcomes"]>>["through"];
type OutcomePage = Awaited<ReturnType<BookApplicationService["outcomes"]>>;
/** "incremental" trusts the prefix this process (or a snapshot it wrote) already verified and
 * checks every new outcome; "full" replays the whole chain from genesis and has the kernel's own
 * function rebuild the book's balances and compare them with the ones carried through the replay. */
export type ReadVerification = "incremental" | "full";
/** How a read applies the outcomes the ledger holds.
 *
 * - "full" (the default): every outcome is executed again by the kernel against the book so far, and the
 *   result must be byte for byte the one the ledger stored. A read costs 0.7 to 1 ms an outcome.
 * - "trusted": for a book with the chain-head state commitment, each stored outcome's revision is applied
 *   to the book as the kernel's `applyRecordedOutcome` does, without executing the command again. The
 *   ledger's hash chain over the stored bytes is what vouches for them; the independent re-execution is
 *   `readAggregate(..., { verify: "full" })`, which always executes every outcome, and the hosted
 *   verifier. A book without the commitment, and a read the kernel refuses a revision of, are read in
 *   full. A trusted service does not save a read snapshot (see `snapshots`): a snapshot is taken for
 *   verified state, and a later service in the default mode would load it as such. */
export type ReplayMode = "full" | "trusted";
/** What a replay ends with: the book, whether it reached the ledger's tip, and the carried balances. */
interface Replayed {
  readonly aggregate: DurableBookAggregate;
  readonly atTip: boolean;
  readonly track: ProjectionTrack | null;
}
/** The ledger does not replay: executing an outcome again gives a result other than the one it stored, or the balances the kernel rebuilds from every revision are not the ones the replay carried. It is the
 * book's own fault and no trouble of the host's (a database closed under a read, a store that did not answer, which are other errors), so a host that checks a book behind its answers stops the book on it. */
export class LedgerReplayError extends Error {
  readonly check = "ledger_replay";
  constructor(message: string) {
    super(message);
    this.name = "LedgerReplayError";
  }
}

/** The state a service has verified through a head of the ledger. It is data, and a service that is made after the database changed beneath another (a pod catching up with what another pod wrote) can begin from it
 * (`ApplicationServiceOptions.view`): the first read then applies only what is after its head, and the ledger refuses a head that is not on its chain, which falls back to a read from the first entry. */
export interface VerifiedView {
  readonly aggregate: DurableBookAggregate;
  readonly head: NativeLedgerHead;
  /** The kernel's balances at this state, carried through the replay that produced it, which a report is
   * compared with. Null when they could not be carried (a revision did not hold for the track): the
   * first report then asks the kernel to rebuild them. Absent on a state just loaded from a snapshot. */
  readonly track?: ProjectionTrack | null;
}
/** A local service saves its verified state after this many new outcomes, and on close. */
/** How long a replay runs before it lets the event loop take a turn. */
const REPLAY_SLICE_MS = 20;
/** The revisions a snapshot's balances are worked out from at a time. */
const TRACK_BATCH = 64;
/** How long a turn of a check lasts (`ApplicationService.verifyLedger`): shorter than a read's, so that what waits for the event loop waits less. */
const CHECK_SLICE_MS = 10;
/** The longest a check pauses between its turns while the process is busy with something else. */
const CHECK_PAUSE_MAX_MS = 100;
/** How many times as long as the event loop was late the check waits again. */
const CHECK_PAUSE_FACTOR = 4;
/** A turn of the event loop that comes back within this many milliseconds found nothing else to do. */
const CHECK_QUIET_MS = 2;
/** How many writes are waiting for a check to end: while there is one, checks do not give way. */
let hurrying = 0;
/** How long a check waits, beyond one turn of the event loop, before its next turn: nothing when the turn came back on time (the process is quiet) or when a write is waiting for the check, and otherwise a few times
 * as long as the turn was late (requests were being answered in it), up to a tenth of a second. A page that is being drawn is not slowed by the check behind it, and the check goes on at full speed when the page is
 * drawn. */
export function checkPause(lateMs: number, writeWaiting: boolean): number {
  if (writeWaiting || lateMs <= CHECK_QUIET_MS) return 0;
  return Math.min(lateMs * CHECK_PAUSE_FACTOR, CHECK_PAUSE_MAX_MS);
}

/** The pause a check makes between its turns (`checkPause`): a turn of the event loop that waits for everything that is ready, and then what the turn showed was needed. */
async function giveWay(): Promise<void> {
  const asked = performance.now();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const late = performance.now() - asked;
  const wait = checkPause(late, hurrying > 0);
  if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
}

/** The checks that services make behind their answers (`ApplicationService.verification`) run one at a time in a process. Each holds a second copy of its book while it runs (about 60 MB for two thousand
 * journals), and a process that opens many books at once, as after a release, would otherwise hold all of them. */
let checking: Promise<unknown> = Promise.resolve();
const oneCheckAtATime = <T>(run: () => Promise<T>): Promise<T> => {
  const turn = checking.then(run);
  checking = turn.catch(() => undefined);
  return turn;
};
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });

const SNAPSHOT_EVERY = 100n;

/** A ledger head as the locator table stores it: in the key order the ledger itself checks. */
const headText = (head: NativeLedgerHead): string =>
  JSON.stringify({
    sequence: head.sequence,
    bookRevision: head.bookRevision,
    chainHash: head.chainHash,
  });
/** A stored head, or null when what is stored is not one (a locator is a hint; a bad one is no hint). */
function storedHead(text: string | null): NativeLedgerHead | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const digits = /^(0|[1-9][0-9]{0,18})$/;
    if (
      typeof value.sequence === "string" &&
      digits.test(value.sequence) &&
      typeof value.bookRevision === "string" &&
      digits.test(value.bookRevision) &&
      typeof value.chainHash === "string" &&
      /^[0-9a-f]{64}$/.test(value.chainHash)
    )
      return {
        sequence: value.sequence,
        bookRevision: value.bookRevision,
        chainHash: value.chainHash,
      };
  } catch {
    // not JSON: no hint
  }
  return null;
}
/** An outcome the ledger holds, and the head of the outcome just before it (what a read of exactly
 * this outcome starts from). */
interface LocatedOutcome {
  readonly outcome: OutcomePage["outcomes"][number];
  readonly before: NativeLedgerHead;
}
type SourceRow = {
  id: string;
  body: string;
  content_hash: string;
  posting_operation_id: string | null;
};
const sourceHash = (source: SourceEvent) => hashCanonical(requestCanonical(source));
const snapshotHash = (encoded: string) =>
  hashCanonical({ type: "ApplicationReadSnapshot", encoded }).digest;

const version = semanticVersion("1.0.0");
/** The stored setup with `basis`, `fiscalYearStartMonth` and `periodModel` defaults applied. */
const parseSetup = (raw: string): ResolvedSetup => resolveSetup(JSON.parse(raw) as BookSetup);

/** The key the stored setup keeps the month fiscal years start in today under, once it differs from the
 * month the book was created with (`periods.changeYearStart`). The month it was created with stays in
 * `fiscalYearStartMonth`, which is what a retried `book.setup` is compared with. */
const CURRENT_MONTH_KEY = "currentFiscalYearStartMonth";

/** The setup as the book keeps it today: the stored setup with the current fiscal-year month. */
function parseCurrentSetup(raw: string): ResolvedSetup {
  const {
    [CURRENT_MONTH_KEY]: current,
    [CURRENT_START_KEY]: began,
    [HISTORY_KEY]: _imported,
    ...rest
  } = JSON.parse(raw) as BookSetup & {
    [CURRENT_MONTH_KEY]?: number;
    [CURRENT_START_KEY]?: string;
    [HISTORY_KEY]?: boolean;
  };
  const created = resolveSetup(rest);
  return {
    ...created,
    ...(current === undefined ? {} : { fiscalYearStartMonth: current }),
    ...(began === undefined ? {} : { booksStartOn: began }),
  };
}

/** The key the stored setup keeps the day the books begin under once a history import has moved it back
 * from the day the book was created with (`booksStartOn`, which stays what it was). */
const CURRENT_START_KEY = "currentBooksStartOn";

/** The key the stored setup keeps the fact that a history was brought in under: the books then begin with
 * entries, so there are no opening balances to add. It is not part of the setup a client reads or sends. */
const HISTORY_KEY = "historyImported";

function assertSetup(value: BookSetup): void {
  if (
    !value ||
    typeof value.name !== "string" ||
    value.name.trim().length < 2 ||
    value.name.length > 120 ||
    !["USD", "EUR", "GBP"].includes(value.currency) ||
    !Number.isSafeInteger(value.fiscalYear) ||
    value.fiscalYear < 2000 ||
    value.fiscalYear > 2100 ||
    !["monthly", "quarterly"].includes(value.periodModel) ||
    !Array.isArray(value.accounts) ||
    value.accounts.length < 2 ||
    value.accounts.length > 200
  )
    throw new TypeError("Invalid book setup");
  if (value.fiscalYearStartMonth !== undefined && !isStartMonth(value.fiscalYearStartMonth))
    throw new TypeError("fiscalYearStartMonth must be a whole number from 1 to 12");
  if (value.basis !== undefined && !isBasis(value.basis))
    throw new TypeError('basis must be "cash" or "accrual"');
  if (
    value.calendarThrough !== undefined &&
    (!Number.isSafeInteger(value.calendarThrough) ||
      value.calendarThrough < value.fiscalYear ||
      value.calendarThrough > 2100)
  )
    throw new TypeError("calendarThrough must be a fiscal year from fiscalYear to 2100");
  if (value.booksStartOn !== undefined && !isDate(value.booksStartOn))
    throw new TypeError("booksStartOn must be a real date, YYYY-MM-DD");
  const codes = new Set<string>();
  for (const account of value.accounts) {
    if (
      !account ||
      typeof account.code !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(account.code) ||
      codes.has(account.code.toLowerCase()) ||
      typeof account.name !== "string" ||
      !account.name.trim() ||
      account.name.length > 120 ||
      !["asset", "liability", "equity", "income", "expense", "gain", "unrealizedGain"].includes(
        account.role,
      )
    )
      throw new TypeError("Invalid starting account");
    codes.add(account.code.toLowerCase());
  }
  if (!value.accounts.some((account) => account.role === "asset"))
    throw new TypeError("A posting asset account is required");
  for (const account of value.accounts) {
    if (account.parentCode !== undefined && !codes.has(account.parentCode.toLowerCase()))
      throw new TypeError("Account parent must exist in the starting chart");
  }
  validateChartTags(value.accounts);
}

/** The day the books begin must fall inside the calendar the new book will have, which runs from
 * the first day of its first fiscal year through the end of the fiscal year it is created in. */
function assertBooksStart(setup: ResolvedSetup): void {
  if (setup.booksStartOn === undefined) return;
  const shape = calendarShape(setup);
  const first = fiscalYearBounds(setup.fiscalYear, shape).startsOn;
  const last = fiscalYearBounds(calendarEndYear(setup), shape).endsOn;
  if (setup.booksStartOn < first || setup.booksStartOn > last)
    throw new TypeError(`booksStartOn must fall inside the book's calendar, ${first} to ${last}`);
}

function genesis(
  setup: ResolvedSetup,
  now: string,
  scope: CompleteBookScope,
): DurableBookAggregate {
  const id = bookId(scope.bookId);
  const currency = commodityId(setup.currency);
  const calendar = fiscalCalendarId("local-calendar");
  const owner = identifier<"BookOwner">("local-entity");
  const shape = calendarShape(setup);
  const start = fiscalYearBounds(setup.fiscalYear, shape).startsOn;
  // The calendar runs from the first fiscal year through the one the book is created in, so a book
  // that starts early (2000 in the web setup) has every year since, and earlier years never have to
  // be added afterwards: a calendar only grows forward.
  const periods = Array.from(
    { length: calendarEndYear(setup) - setup.fiscalYear + 1 },
    (_, index) => kernelFiscalYear(setup.fiscalYear + index, shape, calendar, setup.fiscalYear),
  ).flat();
  const accounts: AccountSnapshot[] = setup.accounts.map((item) => ({
    id: accountId(item.code.toLowerCase()),
    bookId: id,
    code: item.code,
    name: item.name.trim(),
    role: item.role,
    normalSide: ["asset", "expense"].includes(item.role) ? "debit" : "credit",
    postingAllowed: true,
    openedOn: localDate(start),
    ...(item.parentCode ? { parentId: accountId(item.parentCode.toLowerCase()) } : {}),
    allowedCommodityIds: [],
  }));
  const roundingAccount = accounts.find((account) => account.role === "asset");
  if (!roundingAccount) throw new TypeError("A posting asset account is required");
  const policy: BookingPolicy = {
    id: policyId("local-booking"),
    bookId: id,
    version,
    validFrom: instant(`${start}T00:00:00Z`),
    lotSelection: "specificIdentification",
    scope: "legalEntity",
    scopeKey: owner,
    requiredDimensionIds: [],
    implementationVersion: version,
    capability: {
      id: policyCapabilityId("local-specific"),
      method: "specificIdentification",
      scope: "legalEntity",
      status: "supported",
      implementationVersion: version,
      verificationEvidenceIds: [evidenceId("kernel-local-profile")],
    },
  };
  const quantization: QuantizationPolicy = {
    id: quantizationPolicyId("local-quantization"),
    bookId: id,
    version,
    functionalCommodityId: currency,
    validFrom: localDate(start),
    targetScale: 2n,
    roundingMode: "halfEven",
    roundingAccountId: roundingAccount.id,
  };
  return {
    state: createBookState(
      {
        bookId: id,
        code: "LOCAL",
        ownerId: owner,
        ownerKind: "legalEntity",
        kind: "operational",
        functionalCommodityId: currency,
        primaryBasis: setup.basis,
        fiscalCalendarId: calendar,
        accountingTimeZone: "UTC",
      },
      periods,
      {
        bookId: id,
        functionalCommodityId: currency,
        accounts,
        dimensions: [],
        dimensionMembers: [],
        requiredDimensionIds: [],
      },
      [policy],
      [quantization],
      [],
      instant(now),
      // Source identities keep their legacy resolver. The state hash commits to the revision chain
      // head, so verifying a book stays linear in its size instead of quadratic.
      undefined,
      CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
    ),
    protocol: createBookProtocolState(),
  };
}

/** An entry posted from a source (a history import): what a draft with a source is, with amounts in cents. */
export interface SourcedEntry {
  readonly date: string;
  readonly reference: string;
  readonly narration: string;
  readonly source: {
    readonly id: string;
    readonly description: string;
    readonly evidenceReference?: string;
  };
  readonly lines: readonly {
    readonly accountId: string;
    readonly debit: bigint;
    readonly credit: bigint;
  }[];
}

/** Runtime-owned identity and durable ledger port. Clients never receive its credential. */
export interface ApplicationServiceOptions {
  readonly store: ApplicationStore;
  readonly ledger: BookApplicationService;
  readonly credential: () => Promise<BookCredential>;
  readonly scope: CompleteBookScope;
  readonly actorId: string;
  readonly configuredAt?: string;
  /** The clock behind `today()`. Tests inject one; the default is the system clock. */
  readonly now?: () => Date;
  /** Keep a snapshot of the verified book state in product state so a restart replays only the
   * newest outcomes. Off by default: a snapshot is large, and a hosted ledger has row limits and
   * an indexed read model of its own. The local runtime turns it on. */
  readonly snapshots?: boolean;
  /** How a read applies the ledger's outcomes (see `ReplayMode`). Default "full": every outcome is
   * executed again. "trusted" applies the stored revisions instead, an opt-in for a cold open that must
   * be fast (a hosted pod after an eviction); a service in that mode never saves a read snapshot. */
  readonly replay?: ReplayMode;
  /** Runtime ports (file system, database file) the portable service cannot reach itself. */
  readonly host?: ApplicationHost;
  /** The service answers from the stored revisions (`replay: "trusted"`) and **checks the whole ledger behind the first answer**: after its first read of the book it executes every outcome again, in
   * turns that give way to the requests being answered (`checkPause`), with nothing kept, and `verification()` is that check. A write waits for it (`ensureVerified`), so that no command is run on a book that does not replay. This is what a pod does, so that a
   * book is read in a fifth of the time (0.16 to 0.19 ms a journal against 0.7 to 1) and nothing is any less checked than when every read waited for it. */
  readonly verifyBehind?: boolean;
  /** The check under way in the service this one replaces (`verification()`), handed on with its view so that a write still waits for it. */
  readonly verifying?: Promise<void> | null;
  /** The verified state of the service this one replaces (`verifiedView()`), so that its first read applies only the outcomes after it. Nothing is trusted that the ledger does not vouch for: if the ledger
   * does not continue from the head of this view the read starts from the first entry, as without it. */
  readonly view?: VerifiedView | null;
}

export class ApplicationService {
  private readonly db: ApplicationStore;
  readonly ledger: BookApplicationService;
  private readonly clock: () => Date;
  /** Ports the runtime injected; empty when it offers none. */
  readonly host: ApplicationHost;
  private readonly configuredAt: string;
  private readonly scope: CompleteBookScope;
  private readonly actor: ReturnType<typeof actorId>;
  private readonly credentials: () => Promise<BookCredential>;
  private snapshotsEnabled: boolean;
  private readonly replayMode: ReplayMode;
  /** The newest state this instance has verified, so the next read applies only what is new. */
  private view: VerifiedView | null = null;
  private readonly verifyBehind: boolean;
  /** The check of the whole ledger that goes on behind the answers of a service that answers from the stored revisions (`ApplicationServiceOptions.verifyBehind`), once it has been started. */
  private verifying: Promise<void> | null;
  private readQueue: Promise<unknown> = Promise.resolve();

  /** The newest state this instance has verified, or null before its first read. A host that makes a new service on a database that has since moved on gives it to the new one (`ApplicationServiceOptions.view`). */
  verifiedView(): VerifiedView | null {
    return this.view;
  }

  /** The check of the whole ledger that goes on behind this service's answers: null when it is not asked for or has not started (it starts when the first read of the book has been answered), then a
   * promise that settles when every outcome has been executed again and agrees with what the ledger stored, or rejects with what it did not agree on. */
  verification(): Promise<void> | null {
    return this.verifying;
  }

  /** Waits until the ledger has been checked, starting the check if it has not started (the book is read once for that). A host calls it before it runs a write, so that no command is run on a book
   * that does not replay; it settles at once for a service that is not asked to check behind its answers. */
  async ensureVerified(): Promise<void> {
    if (!this.verifyBehind) return;
    // A book that has not been set up has no ledger to read or to check: the command that sets it up is the first thing on it.
    if (this.verifying === null && this.view === null && this.setupState() === null) return;
    if (this.verifying === null) await this.readAggregate();
    // A book that was read has its check, unless the one it had failed for a reason that is not the book's (see `watchVerification`): then it is made again, by this write.
    if (this.verifying === null && this.view !== null) this.startVerification();
    if (this.verifying !== null) {
      // A write is waiting: the check does not give way to the requests that are not.
      hurrying += 1;
      try {
        await this.verifying;
      } finally {
        hurrying -= 1;
      }
    }
  }

  /** The check of the ledger that a service which answers from the stored revisions makes behind its first answer: every outcome is executed again against the book so far, in turns, and its result must be
   * byte for byte the one the ledger stored (what `replay: "full"` does before it answers, and nothing less). It keeps nothing and takes no place in the queue of reads, so the requests waiting are
   * answered between the turns, and between them it gives way (`giveWay`): a page that is being drawn is read at the speed it would be without the check, which then goes on when the process is quiet or a
   * write is waiting for it. It takes the entries added while it runs as it finds them. It does not rebuild the balances from every revision (`readAggregate(undefined, { verify: "full" })`, the
   * verifier's check, which is a single call of some tens of milliseconds for two thousand journals and would hold every other request up). */
  async verifyLedger(): Promise<void> {
    // The stored decode, as a read in `full` mode asks for: comparing what was executed with the text byte for byte says as much as the proof that the text is canonical.
    const page = await this.outcomePage(undefined, undefined, "stored");
    const initial = decodeDurableBook(page.genesis);
    if (initial.disposition !== "decoded") throw new Error("Book genesis could not be decoded");
    await this.replay(
      initial.aggregate,
      page,
      page.observedTip,
      undefined,
      null,
      false,
      "stored",
      true,
    );
  }

  /** The first read of a book that is answered from the stored revisions starts the check behind it, unless that read had to execute the outcomes anyway (a book that cannot be applied from what is stored). */
  private startVerification(): void {
    if (!this.verifyBehind || this.verifying !== null) return;
    this.verifying =
      this.readStats.fallbacks > 0 ? Promise.resolve() : oneCheckAtATime(() => this.verifyLedger());
    this.watchVerification(this.verifying);
  }

  /** A check that fails because the book does not replay (`LedgerReplayError`) stays failed: no command is run on that book. A check that fails for anything else (a read of the ledger that
   * did not complete, the service closed under it) says nothing about the book, so it is forgotten and the next write makes it again. Nobody is left with an unhandled rejection. */
  private watchVerification(check: Promise<void>): void {
    check.catch((error: unknown) => {
      if (!(error instanceof LedgerReplayError) && this.verifying === check) this.verifying = null;
    });
  }
  /** The pass in progress that finds where the ledger holds the outcomes of actions with no locator. */
  private locating: Promise<void> | null = null;
  /** The newest head a ledger call of this instance returned, so a command is submitted after it. */
  private lastHead: NativeLedgerHead | null = null;
  private snapshotSequence = -1n;
  /** Counters for tests and diagnostics: how reads started and how much they verified. `verified` counts
   * the outcomes the kernel executed again; `trusted` the ones applied without (see `ReplayMode`);
   * `fallbacks` the reads of a trusted service that were made in full instead, because the book has no
   * chain-head commitment or the kernel refused a stored revision. */
  readonly readStats = {
    full: 0,
    incremental: 0,
    snapshot: 0,
    verified: 0,
    trusted: 0,
    fallbacks: 0,
    snapshotsWritten: 0,
  };

  constructor(options: ApplicationServiceOptions) {
    this.db = options.store;
    this.ledger = options.ledger;
    this.host = options.host ?? {};
    this.scope = options.scope;
    this.actor = actorId(options.actorId);
    this.credentials = options.credential;
    this.configuredAt = options.configuredAt ?? new Date().toISOString();
    this.clock = options.now ?? (() => new Date());
    this.snapshotsEnabled = options.snapshots === true;
    this.replayMode = options.replay ?? "full";
    this.verifyBehind = options.verifyBehind === true && this.replayMode === "trusted";
    this.view = options.view ?? null;
    this.verifying = options.verifying ?? null;
    if (this.verifying !== null) this.watchVerification(this.verifying);
    if (this.snapshotsEnabled)
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS app_read_snapshots (id INTEGER PRIMARY KEY CHECK (id = 1), sequence TEXT NOT NULL, head TEXT NOT NULL, book_revision TEXT NOT NULL, encoded TEXT NOT NULL, content_hash TEXT NOT NULL)",
      );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS app_book (id INTEGER PRIMARY KEY CHECK (id = 1), setup TEXT NOT NULL, configured_at TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'active')))",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS app_drafts (id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft', 'posting', 'posted')), body TEXT NOT NULL, sealed_command TEXT, outcome_sequence TEXT)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS app_sources (id TEXT PRIMARY KEY, body TEXT NOT NULL, content_hash TEXT NOT NULL, posting_operation_id TEXT)",
    );
    const draftColumns = this.db.query("PRAGMA table_info(app_drafts)").all() as { name: string }[];
    if (!draftColumns.some((column) => column.name === "rejected"))
      this.db.exec("ALTER TABLE app_drafts ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0");
    if (!draftColumns.some((column) => column.name === "recovered_from_operation_id"))
      this.db.exec("ALTER TABLE app_drafts ADD COLUMN recovered_from_operation_id TEXT");
    // The drafts that wait are few among the ones that are posted, and every page of the Journal asks for them: an
    // index of those alone. A page also asks for what was typed as the reference of the entries on it, and an entry
    // that came from a source has the draft that made it found by that source.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS app_drafts_waiting ON app_drafts (status) WHERE status IN ('draft', 'posting')",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS app_drafts_source ON app_drafts (json_extract(body, '$.source.id'))",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS app_actions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, sealed_command TEXT NOT NULL, outcome_sequence TEXT)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS app_requests (id TEXT PRIMARY KEY, operation TEXT NOT NULL, input_hash TEXT NOT NULL, response TEXT NOT NULL)",
    );
    // Where in the ledger to look for an action's outcome (see `findOutcome`). A hint and never the
    // truth: the ledger checks every head it is given, and a book without this table's rows is
    // searched from its start once.
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS app_operation_locators (id TEXT PRIMARY KEY, submit_head TEXT, outcome_after TEXT)",
    );
    const actionColumns = this.db.query("PRAGMA table_info(app_actions)").all() as {
      name: string;
    }[];
    if (!actionColumns.some((column) => column.name === "request_body"))
      this.db.exec("ALTER TABLE app_actions ADD COLUMN request_body TEXT");
    if (!actionColumns.some((column) => column.name === "submitted"))
      this.db.exec("ALTER TABLE app_actions ADD COLUMN submitted INTEGER NOT NULL DEFAULT 0");
    // Earlier browser releases retained posting commands on drafts. Register
    // those exact bytes in the operation index; never rebuild or resubmit them.
    const priorPostings = this.db
      .query(
        "SELECT id, version, sealed_command FROM app_drafts d WHERE sealed_command IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_actions a WHERE a.sealed_command=d.sealed_command)",
      )
      .all() as { id: string; version: number; sealed_command: string }[];
    for (const draft of priorPostings)
      this.retainDraftCommand(draft.id, draft.version, draft.sealed_command);
  }

  private credential(): Promise<BookCredential> {
    return this.credentials();
  }

  get bookId(): string {
    return this.scope.bookId;
  }

  /** Today's date as the book's owner reads a calendar: the local date of this process, written
   * `YYYY-MM-DD`. Anything that asks "has this period ended?" reads it here, so tests can inject
   * a clock instead of depending on the day they run. */
  today(): string {
    const now = this.clock();
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /** The instant now, an ISO string, from the same clock as `today()`: the one a test or a host
   * injected, otherwise the system clock. A slice stamps what it records with this (its own clock
   * defaults to it), so one book never carries times from two clocks and a test that injects a clock
   * can read every stamp back. The kernel's own `recordedAt` is the kernel's and is not read here. */
  now(): string {
    return this.clock().toISOString();
  }

  /** Product-state storage for slices: their own tables, created through `migrate`, and the
   * transaction boundary. The kernel's facts never go through here. */
  get store(): ApplicationStore {
    return this.db;
  }

  /** The actor recorded on every command this service seals. */
  get commandActor(): ReturnType<typeof actorId> {
    return this.actor;
  }

  /** Application-only mutations retain their first response atomically with the
   * draft change. A retry never repeats an edit or revives a discarded draft. */
  retainRequest<T>(id: string, operation: string, input: unknown, work: () => T): T {
    const inputHash = hashCanonical({
      operation,
      input: requestCanonical(input),
    }).digest;
    return this.db.transaction(() => {
      if (this.db.query("SELECT id FROM app_actions WHERE id=?").get(id))
        throw new ApplicationError(
          "operation_identity_conflict",
          "Operation identity belongs to a financial operation",
          409,
        );
      const existing = this.db
        .query("SELECT operation, input_hash, response FROM app_requests WHERE id=?")
        .get(id) as { operation: string; input_hash: string; response: string } | null;
      if (existing) {
        if (existing.operation !== operation || existing.input_hash !== inputHash)
          throw new ApplicationError(
            "operation_identity_conflict",
            "Operation identity was reused for different input",
            409,
          );
        return JSON.parse(existing.response) as T;
      }
      const result = work();
      this.db
        .query("INSERT INTO app_requests (id, operation, input_hash, response) VALUES (?, ?, ?, ?)")
        .run(id, operation, inputHash, JSON.stringify(result));
      return result;
    });
  }

  async retainAsyncRequest<T>(
    id: string,
    operation: string,
    input: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    const inputHash = hashCanonical({
      operation,
      input: requestCanonical(input),
    }).digest;
    if (this.db.query("SELECT id FROM app_actions WHERE id=?").get(id))
      throw new ApplicationError(
        "operation_identity_conflict",
        "Operation identity belongs to a financial operation",
        409,
      );
    this.db
      .query(
        "INSERT OR IGNORE INTO app_requests (id, operation, input_hash, response) VALUES (?, ?, ?, '')",
      )
      .run(id, operation, inputHash);
    const row = this.db
      .query("SELECT operation, input_hash, response FROM app_requests WHERE id=?")
      .get(id) as { operation: string; input_hash: string; response: string };
    if (row.operation !== operation || row.input_hash !== inputHash)
      throw new ApplicationError(
        "operation_identity_conflict",
        "Operation identity was reused for different input",
        409,
      );
    if (row.response) return JSON.parse(row.response) as T;
    const result = await work();
    this.db
      .query("UPDATE app_requests SET response=? WHERE id=? AND response=''")
      .run(JSON.stringify(result), id);
    return result;
  }

  private planHash(id: string, encoded: string): string {
    return hashCanonical({ type: "ApplicationPostingPlan", id, encoded }).digest;
  }

  private async previewAction(
    id: string,
    kind: string,
    encoded: string,
  ): Promise<PreparedOperation> {
    const { aggregate } = await this.readAggregate();
    return (await this.previewOn(aggregate, id, kind, encoded)).prepared;
  }

  /** Preview a retained command as if the book stood at `base`, not at its head. A plan made of
   * several commands, each sealed against the state the previous one leaves, previews each against
   * that state. `next` is the book after the command commits, or null when it would be rejected. */
  async previewChained(
    id: string,
    kind: string,
    base: DurableBookAggregate,
  ): Promise<{ prepared: PreparedOperation; next: DurableBookAggregate | null }> {
    const row = this.db.query("SELECT sealed_command FROM app_actions WHERE id=?").get(id) as {
      sealed_command: string;
    } | null;
    if (!row)
      throw new ApplicationError("operation_not_found", "Prepared operation not found", 404);
    return this.previewOn(base, id, kind, row.sealed_command);
  }

  private async previewOn(
    aggregate: DurableBookAggregate,
    id: string,
    kind: string,
    encoded: string,
  ): Promise<{ prepared: PreparedOperation; next: DurableBookAggregate | null }> {
    const decoded = decodeBookCommand(encoded);
    if (decoded.disposition !== "decoded") throw new Error("Stored command is corrupt");
    const transition = executeBookCommand(aggregate.state, aggregate.protocol, decoded.command);
    const problems =
      transition.result.disposition === "rejected"
        ? explainProblems(
            aggregate.state,
            transition.result.diagnostics.map((item) => ({
              code: item.code,
              message: item.message,
            })),
            decoded.command,
          )
        : [];
    // The journals this command would add are the journal effects of the revision it would make; reading
    // them there, and not by comparing the book's two lists of journals, costs the command and not the book.
    const added =
      transition.result.disposition === "committed"
        ? (latestRevisionRecord(transition.state)?.effects ?? []).flatMap((effect) =>
            effect.type === "journal" ? [effect.booked] : [],
          )
        : [];
    const existingAccounts = new Map(
      aggregate.state.admissionSnapshot.accounts.map((item) => [item.id, item]),
    );
    // Lanes may say what else a plan affects (a reversal of a reconciled line, a close with an
    // unreconciled bank account). Warnings are advisory: they never change `valid` or the hash.
    const warnings = await adviseOnPlan({
      service: this,
      kind,
      command: decoded.command,
      state: aggregate.state,
    });
    const closedPeriod = new Map(
      aggregate.state.closePackages.map((item) => [item.id, item.periodId]),
    );
    const knownPeriods = new Set(aggregate.state.periods.map((item) => item.id));
    const addedPeriods = transition.state.periods.filter((item) => !knownPeriods.has(item.id));
    const prepared: PreparedOperation = {
      disposition: "prepared",
      operationId: id,
      outcomeSequence: null,
      diagnostics: problems.map((item) => item.message),
      problems,
      ...(warnings.length ? { warnings } : {}),
      planId: id,
      planHash: this.planHash(id, encoded),
      bookRevision: decoded.command.expectedBookRevision.toString(),
      kind,
      valid: transition.result.disposition === "committed",
      effects: {
        journals: added.map(({ journal }) => ({
          id: journal.id,
          date: journal.accountingDate,
          narration: journal.narration,
          lines: journal.postings.map((posting) => ({
            accountId: posting.accountId,
            debit:
              posting.bookValue.amount.coefficient > 0n
                ? posting.bookValue.amount.toString()
                : "0.00",
            credit:
              posting.bookValue.amount.coefficient < 0n
                ? posting.bookValue.amount.negate().toString()
                : "0.00",
          })),
        })),
        accounts: transition.state.admissionSnapshot.accounts
          .filter((item) => {
            const prior = existingAccounts.get(item.id);
            return !prior || prior.name !== item.name || prior.closedOn !== item.closedOn;
          })
          .map((item) => ({
            id: item.id,
            code: item.code,
            name: item.name,
            closedOn: item.closedOn ?? null,
          })),
        periods: transition.state.periodTransitions
          .slice(aggregate.state.periodTransitions.length)
          .map((item) => {
            // Reopening a period supersedes the closes of the periods after it; say which.
            const superseded = item.supersededCloseIds.flatMap((closeId) => {
              const periodId = closedPeriod.get(closeId);
              return periodId === undefined || periodId === item.periodId ? [] : [periodId];
            });
            return {
              periodId: item.periodId,
              kind: item.kind,
              reason: item.reason,
              ...(decoded.command.type === "closePeriod"
                ? {
                    closePackageId: decoded.command.closePackageId,
                    reportPopulationHash: decoded.command.reportPopulationHash.digest,
                  }
                : {}),
              ...(superseded.length ? { supersededPeriodIds: superseded } : {}),
            };
          }),
        ...(addedPeriods.length
          ? {
              calendar: addedPeriods.map((item) => ({
                periodId: item.id,
                fiscalYear: Number(item.fiscalYear),
                label: item.label,
                startsOn: item.startsOn,
                endsOn: item.endsOn,
              })),
            }
          : {}),
      },
    };
    return {
      prepared,
      next:
        transition.result.disposition === "committed"
          ? { state: transition.state, protocol: transition.protocol }
          : null,
    };
  }

  /** `committer` says who is asking: a calendar the posting's date needs is extended under their name. */
  async prepareDraft(
    id: string,
    expectedVersion: number,
    operationId: string,
    committer?: Committer,
  ): Promise<PreparedOperation> {
    this.assertActionIdentity(operationId);
    const request = JSON.stringify({ draftId: id, draftVersion: expectedVersion });
    const existing = this.db
      .query("SELECT kind, sealed_command, request_body FROM app_actions WHERE id=?")
      .get(operationId) as { kind: string; sealed_command: string; request_body: string } | null;
    if (existing) {
      if (existing.kind !== "postDraft" || existing.request_body !== request)
        throw new ApplicationError(
          "operation_identity_conflict",
          "Operation identity was reused for different input",
          409,
        );
      return this.previewAction(operationId, "postDraft", existing.sealed_command);
    }
    const draft = this.draft(id);
    if (!draft) throw new ApplicationError("draft_not_found", "Draft not found", 404);
    if (draft.version !== expectedVersion || draft.status !== "draft")
      throw new ApplicationError(
        "draft_version_conflict",
        "Draft changed or is no longer editable",
        409,
      );
    if (draft.data.source) await this.sourcePostingOwner(draft.data.source, operationId);
    const encoded = await this.sealedPosting(draft, operationId, committer);
    this.assertActionIdentity(operationId);
    this.db
      .query(
        "INSERT OR IGNORE INTO app_actions (id, kind, sealed_command, request_body) VALUES (?, 'postDraft', ?, ?)",
      )
      .run(operationId, encoded, request);
    const retained = this.db
      .query("SELECT sealed_command, request_body, kind FROM app_actions WHERE id=?")
      .get(operationId) as { sealed_command: string; request_body: string; kind: string };
    if (retained.kind !== "postDraft" || retained.request_body !== request)
      throw new ApplicationError(
        "operation_identity_conflict",
        "Operation identity was reused for different input",
        409,
      );
    return this.previewAction(operationId, "postDraft", retained.sealed_command);
  }

  /** Send a prepared command to the ledger. `committer` says who is asking and through which operation;
   * it is kept, with the time, beside the command (see slices/changes/store.ts) so the book can say who
   * made each change. Leaving it out is allowed and leaves the change "not recorded": nothing is guessed. */
  async commitAction(
    id: string,
    planHash: string,
    committer?: Committer,
  ): Promise<MutationReceipt> {
    // Made here, before any transaction, so that the first commit of a book is not also a migration.
    const changes = committer ? changesState(this) : null;
    const row = this.db
      .query("SELECT kind, sealed_command, request_body, submitted FROM app_actions WHERE id=?")
      .get(id) as {
      kind: string;
      sealed_command: string;
      request_body: string;
      submitted: number;
    } | null;
    if (!row)
      throw new ApplicationError("operation_not_found", "Prepared operation not found", 404);
    if (this.planHash(id, row.sealed_command) !== planHash)
      throw new ApplicationError(
        "plan_hash_conflict",
        "Prepared operation content does not match the reviewed plan",
        409,
      );
    const decoded = decodeBookCommand(row.sealed_command);
    if (decoded.disposition !== "decoded" || decoded.command.id !== id)
      throw new Error("Stored command identity is corrupt");
    const request =
      row.kind === "postDraft"
        ? (JSON.parse(row.request_body) as { draftId: string; draftVersion: number })
        : null;
    // A retained outcome belongs to the original command, even after its draft
    // is recovered, edited, discarded or successfully posted by a new attempt.
    // Reconcile a lost product-state update without submitting another command.
    if (row.submitted) {
      const retained = await this.operation(id);
      if (retained.disposition === "committed" || retained.disposition === "rejected") {
        const receipt = {
          disposition: retained.disposition,
          operationId: id,
          outcomeSequence: retained.outcomeSequence ?? null,
          diagnostics: retained.diagnostics ?? [],
          problems: retained.problems ?? [],
        };
        this.recordPostingOutcome(id, row.sealed_command, request, receipt);
        return receipt;
      }
    }
    // The newest head the ledger is known to have reached before this command goes: its outcome is
    // somewhere after it, which is where a lookup of the outcome starts (`findOutcome`).
    const submitHead = row.submitted ? null : (this.newestHead() ?? (await this.ledgerHead()));
    const source = request ? this.draft(request.draftId)?.data.source : undefined;
    const sourceOwner = source ? await this.sourcePostingOwner(source, id) : null;
    // Claim the source, lock the draft and retain uncertainty atomically, before
    // crossing the ledger boundary. A competing command cannot bypass a lost reply.
    this.db.transaction(() => {
      if (source) {
        const claimed = this.db
          .query(
            "UPDATE app_sources SET posting_operation_id=? WHERE id=? AND posting_operation_id IS ?",
          )
          .run(id, source.id, sourceOwner);
        if (claimed.changes !== 1)
          throw new ApplicationError(
            "source_claim_conflict",
            "Source posting changed during review. Inspect the source before retrying.",
            409,
          );
      }
      if (request) {
        const draftRow = this.db
          .query("SELECT status, version, sealed_command FROM app_drafts WHERE id=?")
          .get(request.draftId) as {
          status: string;
          version: number;
          sealed_command: string | null;
        } | null;
        if (!draftRow || draftRow.version !== request.draftVersion)
          throw new ApplicationError(
            "draft_version_conflict",
            "Draft changed after preparation",
            409,
          );
        if (draftRow.status === "draft") {
          const changed = this.db
            .query(
              "UPDATE app_drafts SET status='posting', sealed_command=? WHERE id=? AND version=? AND status='draft'",
            )
            .run(row.sealed_command, request.draftId, request.draftVersion);
          if (changed.changes !== 1)
            throw new ApplicationError(
              "draft_version_conflict",
              "Draft changed during posting",
              409,
            );
        } else if (draftRow.sealed_command !== row.sealed_command) {
          throw new ApplicationError(
            "draft_operation_conflict",
            "Another operation owns this draft's posting",
            409,
          );
        }
      }
      this.db.query("UPDATE app_actions SET submitted=1 WHERE id=?").run(id);
      // With the mark that it was sent, so a crash cannot leave a committed command without its committer.
      // The first to ask is kept: a retry of a command that was sent only reconciles it.
      if (committer && changes) changes.recordCommit(id, committer, this.now());
      if (submitHead) this.noteSubmission(id, submitHead);
    });
    const receipt = await this.ledger.execute(await this.credential(), decoded.command);
    this.noteHead(receipt.head);
    const original = receipt.value.originalResult ?? receipt.value.result;
    const problems =
      original.disposition === "rejected"
        ? original.diagnostics.map((item) => ({ code: item.code, message: item.message }))
        : [];
    const result = {
      disposition: original.disposition,
      operationId: id,
      outcomeSequence: receipt.value.outcomeSequence,
      diagnostics: problems.map((item) => item.message),
      problems,
    };
    // A configuration that draws the calendar again under another month is what `book.get` reports from
    // the moment it commits; reading the ledger's head brings the stored month into line otherwise.
    if (original.disposition === "committed" && decoded.command.type === "replaceConfiguration") {
      const periods = decoded.command.periods;
      this.recordYearStart((known) => monthOfPeriods(periods, known));
    }
    this.recordPostingOutcome(id, row.sealed_command, request, result);
    return result;
  }

  private recordPostingOutcome(
    id: string,
    sealed: string,
    request: { draftId: string; draftVersion: number } | null,
    receipt: MutationReceipt,
  ): void {
    this.db
      .query("UPDATE app_actions SET outcome_sequence=? WHERE id=?")
      .run(receipt.outcomeSequence, id);
    this.placeOutcome(id, receipt.outcomeSequence);
    if (request)
      this.db
        .query(
          "UPDATE app_drafts SET status=?, rejected=?, outcome_sequence=? WHERE id=? AND version=? AND sealed_command=?",
        )
        .run(
          receipt.disposition === "committed" ? "posted" : "posting",
          receipt.disposition === "rejected" ? 1 : 0,
          receipt.outcomeSequence,
          request.draftId,
          request.draftVersion,
          sealed,
        );
  }

  /** What the ledger holds for an operation: its outcome (committed or rejected), or that it was prepared
   * and never sent, or sent and not answered. The ledger is the authority; what is read from it here is
   * checked against the command this service kept. An action that was never submitted has nothing in
   * the ledger and costs no read. One that was is read where it is (`findOutcome`), not searched for,
   * so the cost does not grow with the book. */
  async operation(id: string) {
    const application = this.db
      .query("SELECT operation, response FROM app_requests WHERE id=?")
      .get(id) as { operation: string; response: string } | null;
    if (application && !application.response)
      return { operationId: id, kind: application.operation, disposition: "unresolved" };
    if (application)
      return {
        operationId: id,
        disposition: "completed",
        kind: application.operation,
        result: JSON.parse(application.response) as unknown,
      };
    const action = this.db
      .query("SELECT kind, sealed_command, submitted, outcome_sequence FROM app_actions WHERE id=?")
      .get(id) as {
      kind: string;
      sealed_command: string;
      submitted: number;
      outcome_sequence: string | null;
    } | null;
    if (!action) throw new ApplicationError("operation_not_found", "Operation not found", 404);
    if (!action.submitted)
      return {
        operationId: id,
        kind: action.kind,
        disposition: "prepared",
        planHash: this.planHash(id, action.sealed_command),
      };
    const located = await this.findOutcome(id, action.outcome_sequence);
    if (located) {
      const outcome = located.outcome;
      const retainedCommand = decodeBookCommand(action.sealed_command);
      if (
        retainedCommand.disposition !== "decoded" ||
        retainedCommand.command.id !== id ||
        retainedCommand.command.inputHash.digest !== outcome.payload.command.inputHash.digest
      )
        throw new Error("Retained command conflicts with its durable outcome");
      const result = outcome.payload.originalResult;
      return {
        operationId: id,
        kind: action.kind,
        disposition: result.disposition,
        outcomeSequence: outcome.head.sequence,
        diagnostics:
          result.disposition === "rejected" ? result.diagnostics.map((item) => item.message) : [],
        problems:
          result.disposition === "rejected"
            ? result.diagnostics.map((item) => ({ code: item.code, message: item.message }))
            : [],
        planHash: this.planHash(id, action.sealed_command),
      };
    }
    return {
      operationId: id,
      kind: action.kind,
      disposition: "unresolved",
      planHash: this.planHash(id, action.sealed_command),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Where an action's outcome is. The ledger's pages are read after a head it checks, so reading one
  // outcome takes the head of the outcome before it. `app_operation_locators` keeps, per action, the
  // head the ledger had reached when the command was submitted (`submit_head`: its outcome is after it)
  // and the head just before its outcome (`outcome_after`: its outcome is the next one). They are hints:
  // the ledger refuses a head that is not on its chain, what it returns is what is used, and a hint
  // that does not lead to the command is forgotten and found again.

  private locator(id: string): {
    submitHead: NativeLedgerHead | null;
    outcomeAfter: NativeLedgerHead | null;
  } {
    const row = this.db
      .query("SELECT submit_head, outcome_after FROM app_operation_locators WHERE id=?")
      .get(id) as { submit_head: string | null; outcome_after: string | null } | null;
    return {
      submitHead: storedHead(row?.submit_head ?? null),
      outcomeAfter: storedHead(row?.outcome_after ?? null),
    };
  }

  /** The command is being submitted after this head; kept from the first submission only. */
  private noteSubmission(id: string, head: NativeLedgerHead): void {
    this.db
      .query(
        "INSERT INTO app_operation_locators (id, submit_head) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET submit_head=COALESCE(submit_head, excluded.submit_head)",
      )
      .run(id, headText(head));
  }

  /** The command's outcome is the one after this head. */
  private noteOutcomePlace(id: string, before: NativeLedgerHead): void {
    this.db
      .query(
        "INSERT INTO app_operation_locators (id, outcome_after) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET outcome_after=excluded.outcome_after",
      )
      .run(id, headText(before));
  }

  /** The outcome was just made, at `sequence`. When the head the command was submitted after is the one
   * right before it (nothing else was written in between, the usual case), that head is the place. */
  private placeOutcome(id: string, sequence: string | null): void {
    if (sequence === null) return;
    const { submitHead, outcomeAfter } = this.locator(id);
    if (outcomeAfter || !submitHead) return;
    if (BigInt(submitHead.sequence) + 1n === BigInt(sequence))
      this.noteOutcomePlace(id, submitHead);
  }

  /** The newest head this instance knows the ledger reached: where its last verified read ended or its
   * last command left the book. */
  private newestHead(): NativeLedgerHead | null {
    const read = this.view?.head ?? null;
    const written = this.lastHead;
    if (read && written) return BigInt(read.sequence) >= BigInt(written.sequence) ? read : written;
    return read ?? written;
  }

  private noteHead(head: NativeLedgerHead | undefined): void {
    if (head && (!this.lastHead || BigInt(head.sequence) > BigInt(this.lastHead.sequence)))
      this.lastHead = head;
  }

  /** The ledger's outcome of a command, with the head of the outcome before it, or null when the ledger
   * has none. `recorded` is the outcome sequence this service wrote down when it saw the outcome. */
  private async findOutcome(id: string, recorded: string | null): Promise<LocatedOutcome | null> {
    const place = this.locator(id);
    if (place.outcomeAfter) {
      const found = await this.outcomeAt(id, place.outcomeAfter);
      if (found) return found;
      // The place does not lead to the command (a ledger replaced or restored under the product state):
      // nothing stored for it is to be believed.
      this.db.query("DELETE FROM app_operation_locators WHERE id=?").run(id);
    } else if (place.submitHead) {
      let found: LocatedOutcome | null = null;
      let refused = false;
      try {
        found = await this.searchFrom(id, place.submitHead);
      } catch {
        refused = true;
      }
      if (found) {
        this.noteOutcomePlace(id, found.before);
        return found;
      }
      // Nothing after the head it was submitted at is the answer, unless this service already wrote
      // down an outcome for it, or the ledger would not continue from that head.
      if (!refused && recorded === null) return null;
      this.db.query("DELETE FROM app_operation_locators WHERE id=?").run(id);
    }
    // No usable place: one pass over the book finds every action that has none (once per book).
    await this.locateFromStart();
    const placed = this.locator(id).outcomeAfter;
    return placed ? await this.outcomeAt(id, placed) : null;
  }

  /** The outcome right after `after`, if it is the command's. */
  private async outcomeAt(id: string, after: NativeLedgerHead): Promise<LocatedOutcome | null> {
    let page: OutcomePage;
    try {
      page = await this.outcomePage(after, 1);
    } catch {
      return null;
    }
    const outcome = page.outcomes[0];
    return outcome && outcome.payload.command.id === id ? { outcome, before: page.from } : null;
  }

  /** The command's outcome among the ones after `start` (the first outcome when null), reading on to
   * the end of the book as it is when the reading ends. The chain only grows and each page continues
   * from the head the one before ended at, so a book that is written to meanwhile is no problem. */
  private async searchFrom(
    id: string,
    start: NativeLedgerHead | null,
  ): Promise<LocatedOutcome | null> {
    let page = await this.outcomePage(start ?? undefined);
    for (;;) {
      let before = page.from;
      for (const outcome of page.outcomes) {
        if (outcome.payload.command.id === id) return { outcome, before };
        before = outcome.head;
      }
      if (page.through.sequence === page.observedTip.sequence) return null;
      if (page.outcomes.length === 0) throw new Error("Book outcome page gap");
      page = await this.outcomePage(page.through);
    }
  }

  /** Make `findOutcome` flat for every action a book already has, by one pass over its outcomes. It
   * happens for a book that has no locators (made before they existed, or rebuilt from an export),
   * the first time one of its actions is looked up, and not again. Callers that arrive while it runs
   * wait for it. It hands the thread back as a replay does. */
  private locateFromStart(): Promise<void> {
    this.locating ??= this.locatePass().finally(() => {
      this.locating = null;
    });
    return this.locating;
  }

  private async locatePass(): Promise<void> {
    const wanted = new Set(
      (
        this.db
          .query(
            "SELECT id FROM app_actions a WHERE submitted=1 AND NOT EXISTS (SELECT 1 FROM app_operation_locators l WHERE l.id=a.id AND l.outcome_after IS NOT NULL)",
          )
          .all() as { id: string }[]
      ).map((row) => row.id),
    );
    const found = new Map<string, NativeLedgerHead>();
    let page = await this.outcomePage();
    let sliceStart = performance.now();
    for (;;) {
      let before = page.from;
      for (const outcome of page.outcomes) {
        if (wanted.has(outcome.payload.command.id)) found.set(outcome.payload.command.id, before);
        before = outcome.head;
        if (performance.now() - sliceStart >= REPLAY_SLICE_MS) {
          await yieldToEventLoop();
          sliceStart = performance.now();
        }
      }
      if (page.through.sequence === page.observedTip.sequence) break;
      if (page.outcomes.length === 0) throw new Error("Book outcome page gap");
      page = await this.outcomePage(page.through);
    }
    // What the pass did not find was not in the book as far as it read: it can only be after that.
    const reached = page.through;
    this.db.transaction(() => {
      for (const id of wanted) {
        const place = found.get(id);
        if (place) this.noteOutcomePlace(id, place);
        else this.noteSubmission(id, reached);
      }
    });
  }

  actionKind(id: string): string {
    const row = this.db.query("SELECT kind FROM app_actions WHERE id=?").get(id) as {
      kind: string;
    } | null;
    if (!row)
      throw new ApplicationError("operation_not_found", "Prepared operation not found", 404);
    return row.kind;
  }

  private assertOperationIdentity(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      throw new ApplicationError("invalid_operation_id", "Use a UUID operation identity");
  }

  private assertActionIdentity(id: string): void {
    this.assertOperationIdentity(id);
    if (this.db.query("SELECT id FROM app_requests WHERE id=?").get(id))
      throw new ApplicationError(
        "operation_identity_conflict",
        "Operation identity belongs to a draft operation",
        409,
      );
  }

  private retainDraftCommand(draftId: string, draftVersion: number, sealed: string): string {
    const decoded = decodeBookCommand(sealed);
    if (decoded.disposition !== "decoded" || decoded.command.type !== "postJournal")
      throw new Error("Stored draft command is invalid");
    const id = decoded.command.id;
    this.assertActionIdentity(id);
    const requestBody = JSON.stringify({ draftId, draftVersion });
    this.db
      .query(
        "INSERT OR IGNORE INTO app_actions (id, kind, sealed_command, request_body, submitted) VALUES (?, 'postDraft', ?, ?, 1)",
      )
      .run(id, sealed, requestBody);
    const retained = this.db
      .query("SELECT kind, sealed_command, request_body FROM app_actions WHERE id=?")
      .get(id) as { kind: string; sealed_command: string; request_body: string };
    if (
      retained.kind !== "postDraft" ||
      retained.sealed_command !== sealed ||
      retained.request_body !== requestBody
    )
      throw new Error("Stored draft operation identity conflicts");
    return id;
  }

  /** The configured book's setup with defaults applied (`basis` accrual, `fiscalYearStartMonth`
   * 1), or null before setup. Books created before those fields existed read the same way. */
  setupState(): ResolvedSetup | null {
    const row = this.db.query("SELECT setup, status FROM app_book WHERE id=1").get() as {
      setup: string;
      status: string;
    } | null;
    return row?.status === "active" ? parseCurrentSetup(row.setup) : null;
  }

  /** Rename the business. The name is product state: the ledger's book carries none, so only the
   * stored setup changes, and everything that reads `setupState()` (reports, exports, the header)
   * shows the new name at once. Returns the name it replaced. Callers go through `book.update`,
   * which validates the name and retains the request. */
  renameBook(name: string): string {
    const row = this.db
      .query("SELECT setup FROM app_book WHERE id=1 AND status='active'")
      .get() as {
      setup: string;
    } | null;
    if (!row) throw new Error("Book is not configured");
    const stored = JSON.parse(row.setup) as BookSetup;
    this.db
      .query("UPDATE app_book SET setup=? WHERE id=1")
      .run(JSON.stringify({ ...stored, name }));
    return stored.name;
  }

  async setup(
    value: BookSetup,
    committer?: Committer,
  ): Promise<{ setup: ResolvedSetup; outcomeSequence: string }> {
    assertSetup(value);
    const resolved = resolveSetup(value);
    const row = this.db
      .query("SELECT setup, configured_at, status FROM app_book WHERE id=1")
      .get() as { setup: string; configured_at: string; status: string } | null;
    if (row && !sameSetup(parseSetup(row.setup), value)) throw new Error("Book already configured");
    if (row?.status === "active") {
      const page = await this.outcomePage();
      return {
        setup: resolved,
        outcomeSequence: page.outcomes[0]?.head.sequence ?? page.from.sequence,
      };
    }
    const now = row?.configured_at ?? this.configuredAt;
    // The last year of the calendar is decided once, the first time the book is set up, and kept
    // with the setup, so a setup that is retried builds the same book.
    const stored: ResolvedSetup = row
      ? parseSetup(row.setup)
      : {
          ...resolved,
          calendarThrough: resolved.calendarThrough ?? calendarThroughFor(resolved, this.today()),
        };
    assertBooksStart(stored);
    if (!row)
      this.db
        .query(
          "INSERT INTO app_book (id, setup, configured_at, status) VALUES (1, ?, ?, 'pending')",
        )
        .run(JSON.stringify({ ...value, calendarThrough: stored.calendarThrough }), now);
    const initial = genesis(stored, now, this.scope);
    const firstDate = fiscalYearBounds(stored.fiscalYear, calendarShape(stored)).startsOn;
    const activation = sealCommand({
      id: commandId("local-activate"),
      type: "activateBook",
      protocolVersion: version,
      bookId: bookId(this.scope.bookId),
      expectedBookRevision: 0n,
      actorId: this.actor,
      issuedAt: instant(now),
      completedAt: instant(now),
      committedAt: instant(now),
      mode: "newZeroBalance",
      boundaryId: openingBoundaryId("local-opening"),
      firstAccountingDate: localDate(firstDate),
    });
    // Who opened the book, kept before the ledger is asked, as `commitAction` does for every other command.
    if (committer) changesState(this).recordCommit(activation.id, committer, this.now());
    const receipt = await this.ledger.provision(await this.credential(), initial, activation);
    if (receipt.result.disposition !== "committed")
      throw new Error("Book activation did not commit");
    this.db.query("UPDATE app_book SET status='active' WHERE id=1 AND status='pending'").run();
    return { setup: resolved, outcomeSequence: receipt.outcomeSequence };
  }

  async outcomePage(
    after?: Parameters<BookApplicationService["outcomes"]>[1],
    limit?: number,
    decoding?: Parameters<BookApplicationService["outcomes"]>[3],
  ) {
    return this.ledger.outcomes(await this.credential(), after, limit, decoding);
  }

  /** Where the ledger ends now. A service that has read the book asks only for what came after the head
   * it read, so a screen that wants to know whether the book moved does not decode the first page of the
   * book (sixteen outcomes, about 3 ms) to find out; one that has not read it yet, or whose database was
   * replaced under it, reads from the start. */
  async ledgerHead(): Promise<NativeLedgerHead> {
    const known = this.view?.head;
    if (known) {
      try {
        return (await this.outcomePage(known)).observedTip;
      } catch {
        // The ledger no longer continues from that head (a restored or replaced database).
      }
    }
    return (await this.outcomePage()).observedTip;
  }

  /** The verified state of the book. A full replay runs one kernel command per outcome. For a book
   * created with the state commitment profile, which every book this service sets up carries, a
   * command costs the same at 20,000 journals as at 200, so a replay is linear (under a
   * millisecond an outcome on a laptop); a book created before the profile re-hashes its whole
   * history on every command, so its replay is quadratic. Either way reads are incremental: this
   * instance keeps the newest state it has verified and, on the next read, fetches only the
   * outcomes after it, checks each against the kernel's own transition and applies it. Reading
   * `state.journals`, `state.revisions` or `protocol.retainedResults` of a state the kernel built
   * copies that whole list once (50 to 130 ns an element), so code on this path reads their ends
   * through `latestRevisionRecord` and `latestRetainedCommandResult`. A local service also saves a
   * snapshot every SNAPSHOT_EVERY outcomes and on close, so a restart replays only the tail. The ledger
   * authenticates the head a read continues from, so a restored or replaced database is detected
   * and falls back to a full replay. An incremental read trusts the prefix already verified in this
   * process or in a snapshot this service wrote; `verify: "full"` ignores both and replays the
   * whole chain from genesis (slow on a large book: use it for integrity checks, not per request),
   * and then has the kernel's own function rebuild the balances from every revision and compares them
   * with the ones carried through the replay (the balances a report is checked against). A service
   * opened with `replay: "trusted"` applies the stored revisions of a chain-head book instead of
   * executing them (see `ReplayMode`): about a fifth of the time, with `verify: "full"` as the check.
   * Reads are serialised so concurrent callers extend one view instead of replaying the same tail. */
  async readAggregate(
    targetRevision?: bigint,
    options: { readonly verify?: ReadVerification } = {},
  ): Promise<{ aggregate: DurableBookAggregate; head: NativeLedgerHead }> {
    const run = this.readQueue.then(() =>
      this.readAggregateNow(targetRevision, options.verify ?? "incremental"),
    );
    this.readQueue = run.then(
      () => undefined,
      () => undefined,
    );
    const read = await run;
    if (targetRevision === undefined) this.keepYearStartCurrent(read.aggregate.state);
    return read;
  }

  /** The month fiscal years start in is read from the ledger wherever the calendar is used. What
   * `book.get` reports is the stored month, which is cheap to answer before the book is read; this
   * brings it into line the first time the ledger is read after `periods.changeYearStart` committed, or
   * after a crash between the commit and a read. */
  private keepYearStartCurrent(state: BookState): void {
    this.recordYearStart((known) => calendarMonthOf(state, known));
  }

  /** Store the month fiscal years start in today, given what is stored now; nothing is written when it
   * is the same. */
  private recordYearStart(monthOf: (known: number) => number): void {
    const row = this.db
      .query("SELECT setup FROM app_book WHERE id=1 AND status='active'")
      .get() as {
      setup: string;
    } | null;
    if (!row) return;
    const stored = JSON.parse(row.setup) as BookSetup & { [CURRENT_MONTH_KEY]?: number };
    const known = stored[CURRENT_MONTH_KEY] ?? resolveSetup(stored).fiscalYearStartMonth;
    const month = monthOf(known);
    if (month === known) return;
    this.db
      .query("UPDATE app_book SET setup=? WHERE id=1")
      .run(JSON.stringify({ ...stored, [CURRENT_MONTH_KEY]: month }));
  }

  private async readAggregateNow(
    targetRevision: bigint | undefined,
    verify: ReadVerification,
  ): Promise<{ aggregate: DurableBookAggregate; head: NativeLedgerHead }> {
    // A trusted service applies the stored revisions of a book with the chain-head commitment without
    // executing them again (see `ReplayMode`); anything else, and a trusted read the kernel refuses a
    // revision of, is read in full. `verify: "full"` is always in full.
    const trusting = this.replayMode === "trusted" && verify !== "full";
    // The ledger is asked to prove that each stored text is the canonical encoding of its payload (the third of
    // the cost of reading an outcome) only where nothing else looks at the text. A trusted read does not ask: the
    // ledger's chain vouches for the bytes and `verify: "full"` is the check. A read in full, which compares the
    // encoding of what it executed with the text byte for byte, loses nothing by not asking either: a text that is
    // not the canonical encoding of its payload is not the encoding of the result of its command, and the
    // comparison refuses it. So every page of a read is decoded so, in the default mode too (about a fifth of a
    // replay, docs/reference/program/scale/coldstart.md, decision 6), except a full verification's, which keeps
    // the strictest decode there is.
    const decoding = verify === "full" ? undefined : "stored";
    // A view is only a usable start if it is not past the revision being asked for.
    const usable = (view: VerifiedView | null) =>
      view !== null &&
      (targetRevision === undefined || view.aggregate.state.bookRevision <= targetRevision)
        ? view
        : null;
    let start: VerifiedView | null = null;
    let from: "view" | "snapshot" | null = null;
    if (verify !== "full") {
      start = usable(this.view);
      if (start) from = "view";
      else {
        start = usable(this.loadSnapshot());
        if (start) from = "snapshot";
      }
    }
    let page: OutcomePage;
    let aggregate: DurableBookAggregate;
    for (;;) {
      if (start) {
        try {
          page = await this.outcomePage(start.head, undefined, decoding);
        } catch {
          // The ledger no longer continues from the saved head (a restored or replaced
          // database): forget it and replay from genesis.
          if (from === "view") {
            this.view = null;
            this.verifying = null;
          } else this.dropSnapshot();
          start = null;
          from = null;
          continue;
        }
        aggregate = start.aggregate;
        if (from === "view") this.readStats.incremental += 1;
        else this.readStats.snapshot += 1;
      } else {
        page = await this.outcomePage(undefined, undefined, decoding);
        const initial = decodeDurableBook(page.genesis);
        if (initial.disposition !== "decoded") throw new Error("Book genesis could not be decoded");
        aggregate = initial.aggregate;
        this.readStats.full += 1;
      }
      break;
    }
    const pinned = page.observedTip;
    if (targetRevision !== undefined && aggregate.state.bookRevision === targetRevision)
      return { aggregate, head: pinned };
    // The kernel's balances at the state the replay starts from, carried through every revision it applies
    // (see `ProjectionTrack`), so that by the time the book is read they are known and no report has to
    // go back over the whole history for them. A replay from genesis starts with none to carry; a view
    // this process verified already has them; a snapshot's are worked out from its revisions, in slices.
    const track =
      from === null
        ? ProjectionTrack.start()
        : from === "view"
          ? (start?.track ?? null)
          : await this.trackThrough(aggregate.state);
    // A service that checks the ledger behind its answers applies from the stored revisions only the book it builds from the first entry, which the check then executes; what is added to a book it
    // has already read is executed as it is read, as in a full service: it is a few entries, and nothing would execute them later.
    const trustingNow = trusting && !(this.verifyBehind && from !== null);
    let replayed: Replayed | null =
      trustingNow &&
      aggregate.state.activeConfigurationSnapshot.stateCommitmentProfile ===
        CHAIN_HEAD_STATE_COMMITMENT_PROFILE
        ? await this.replay(aggregate, page, pinned, targetRevision, track, true, decoding)
        : null;
    if (replayed === null) {
      if (trustingNow) this.readStats.fallbacks += 1;
      replayed = await this.replay(aggregate, page, pinned, targetRevision, track, false, decoding);
    }
    // A track that is not at the state it ends in is not the state's balances: forget it.
    const carried =
      replayed.track !== null &&
      vouchProjection(replayed.aggregate.state, replayed.track.projection)
        ? replayed.track
        : null;
    if (verify === "full") {
      // The independent check, on request. The replay re-executed every outcome against the ledger's
      // record of it; now the kernel's own function rebuilds the balances from every revision, re-checking
      // every hash, and they must be exactly the ones carried through the replay.
      const disagreement = projectionDisagreement(
        replayed.aggregate.state,
        carried?.projection ?? null,
      );
      if (disagreement !== null)
        throw new LedgerReplayError(
          `Book balances do not match the kernel's rebuild: ${disagreement}`,
        );
    }
    if (replayed.atTip) {
      this.view = { aggregate: replayed.aggregate, head: pinned, track: carried };
      if (trustingNow && from === null) this.startVerification();
      if (this.savingSnapshots && BigInt(pinned.sequence) - this.snapshotSequence >= SNAPSHOT_EVERY)
        try {
          this.saveSnapshot(this.view);
        } catch {
          // The kernel refuses to encode a book above 16 MiB (about 1,600 journals of two lines) or
          // with a list of more than 10,000 items. Such a book is still read correctly from the view
          // verified in this process; it only cannot save a newer snapshot, so a restart reads the last
          // one it saved and replays the entries since, or the whole book (a millisecond an entry for a
          // book with the chain-head state commitment). Stop trying, and never fail a read because
          // of it.
          this.snapshotsEnabled = false;
        }
    }
    return { aggregate: replayed.aggregate, head: pinned };
  }

  /** Verify every outcome of this page and the pages after it against the kernel's own transition
   * and apply them, under one pinned head. A long replay hands the thread back every few tens of
   * milliseconds, so a request that does not need the book (the health check, a read of something
   * else) is answered while it runs; one kernel command still costs what it costs.
   *
   * Each revision a command makes is also folded into `from`, the kernel's balances at the state the
   * replay started from (see `ProjectionTrack`), a page at a time, so the replay ends with the balances of
   * the state it ends in, spread over the replay instead of paid in one block by the first report. The
   * revision has just been compared, byte for byte, with the ledger's record of the command, so its hashes
   * are not computed a second time (`RevisionChecks`, "applied"): what is added is the arithmetic and the
   * revision's number, link and posting sequence. (In a trusted replay it has not been compared: it was
   * applied from the record, and the same cheap checks are all that is made; `verify: "full"` is the check.)
   * The track ends (null) if a revision does not hold for it, and the first report then asks the kernel
   * for the balances.
   *
   * With `trusted`, the book is a chain-head book and each outcome is applied to it as the ledger stored it,
   * without executing its command again (`applyRecordedOutcome`): the same state, protocol and track as
   * the execution gives, at the cost of reading the outcome. The result is null when the kernel refuses an
   * outcome (a record that does not follow the book), and the caller then replays in full. */
  private replay(
    aggregate: DurableBookAggregate,
    first: OutcomePage,
    pinned: NativeLedgerHead,
    targetRevision: bigint | undefined,
    from: ProjectionTrack | null,
    trusted: false,
    decoding: Parameters<BookApplicationService["outcomes"]>[3],
    growing?: boolean,
  ): Promise<Replayed>;
  private replay(
    aggregate: DurableBookAggregate,
    first: OutcomePage,
    pinned: NativeLedgerHead,
    targetRevision: bigint | undefined,
    from: ProjectionTrack | null,
    trusted: true,
    decoding: Parameters<BookApplicationService["outcomes"]>[3],
    growing?: boolean,
  ): Promise<Replayed | null>;
  private async replay(
    aggregate: DurableBookAggregate,
    first: OutcomePage,
    pinned: NativeLedgerHead,
    targetRevision: bigint | undefined,
    from: ProjectionTrack | null,
    trusted: boolean,
    decoding: Parameters<BookApplicationService["outcomes"]>[3],
    growing = false,
  ): Promise<Replayed | null> {
    let page = first;
    let track = from;
    let applied: RevisionRecord[] = [];
    const fold = () => {
      if (track !== null && applied.length > 0)
        try {
          track = track.advance(applied, "applied");
        } catch {
          // Whatever stops the carrying must not stop the read: the first report asks the kernel.
          track = null;
        }
      applied = [];
    };
    let sliceStart = performance.now();
    const slice = growing ? CHECK_SLICE_MS : REPLAY_SLICE_MS;
    while (true) {
      // A read that builds the book this service answers from takes it as it was when it began, and a book that moved on under it is read again. A check that only looks (`verifyLedger`) takes
      // every entry up to where the book stood when it began, and what was added meanwhile it may read too: it keeps nothing, and each page continues from the one before.
      if (
        !growing &&
        (page.observedTip.chainHash !== pinned.chainHash ||
          page.observedTip.sequence !== pinned.sequence)
      )
        throw new Error("Book changed during read; retry");
      for (const outcome of page.outcomes) {
        if (trusted) {
          const next = applyRecordedOutcome(aggregate.state, aggregate.protocol, outcome.payload);
          if (next.disposition !== "applied") return null;
          if (track !== null && outcome.payload.revision !== null)
            applied.push(outcome.payload.revision);
          aggregate = { state: next.state, protocol: next.protocol };
          this.readStats.trusted += 1;
        } else {
          const transition = executeBookCommand(
            aggregate.state,
            aggregate.protocol,
            outcome.payload.command,
          );
          // The tail helpers, not `.retainedResults.at(-1)`: reading a built state's lists copies
          // and freezes the whole history, which would make every replayed command O(n) again.
          const retained = latestRetainedCommandResult(transition.protocol);
          if (!retained || retained.commandId !== outcome.payload.command.id)
            throw new LedgerReplayError("Book outcome replay failed");
          const revision =
            transition.result.disposition === "committed"
              ? (latestRevisionRecord(transition.state) ?? null)
              : null;
          const expected = encodeBookOutcome({
            command: retained.command,
            originalResult: transition.result as typeof outcome.payload.originalResult,
            revision,
          });
          if (expected !== outcome.encoded)
            throw new LedgerReplayError("Book outcome does not match its kernel result");
          // Only a revision this command made is new to the track.
          if (
            track !== null &&
            revision !== null &&
            transition.state.bookRevision !== aggregate.state.bookRevision
          )
            applied.push(revision);
          aggregate = { state: transition.state, protocol: transition.protocol };
          this.readStats.verified += 1;
        }
        if (targetRevision !== undefined && aggregate.state.bookRevision === targetRevision) {
          fold();
          return { aggregate, atTip: outcome.head.sequence === pinned.sequence, track };
        }
        if (performance.now() - sliceStart >= slice) {
          await (growing ? giveWay() : yieldToEventLoop());
          sliceStart = performance.now();
        }
      }
      fold();
      if (
        growing
          ? BigInt(page.through.sequence) >= BigInt(pinned.sequence)
          : page.through.sequence === pinned.sequence
      ) {
        if (targetRevision !== undefined) throw new TypeError("Book revision was not found");
        return { aggregate, atTip: true, track };
      }
      if (page.outcomes.length === 0) throw new Error("Book outcome page gap");
      page = await this.outcomePage(page.through, undefined, decoding);
    }
  }

  /** The kernel's balances at a state that was loaded rather than replayed (a snapshot's), worked out
   * from its revisions in slices that hand the thread back as a replay does. A snapshot holds a book of at
   * most about 1,600 journals, so this is a few tens of milliseconds. Null if a revision does not hold. */
  private async trackThrough(state: BookState): Promise<ProjectionTrack | null> {
    let track: ProjectionTrack | null = ProjectionTrack.start();
    const revisions = state.revisions;
    let sliceStart = performance.now();
    for (let at = 0; track !== null && at < revisions.length; at += TRACK_BATCH) {
      try {
        track = track.advance(revisions.slice(at, at + TRACK_BATCH));
      } catch {
        return null;
      }
      if (performance.now() - sliceStart >= REPLAY_SLICE_MS) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
    }
    return track;
  }

  /** Whether this service writes read snapshots. A trusted service reads one a full service wrote but
   * does not write its own: a snapshot is loaded later as verified state, and what a trusted read built
   * was never executed again. */
  private get savingSnapshots(): boolean {
    return this.snapshotsEnabled && this.replayMode !== "trusted";
  }

  private loadSnapshot(): VerifiedView | null {
    if (!this.snapshotsEnabled) return null;
    const row = this.db
      .query("SELECT head, encoded, content_hash FROM app_read_snapshots WHERE id=1")
      .get() as { head: string; encoded: string; content_hash: string } | null;
    if (!row) return null;
    try {
      if (snapshotHash(row.encoded) !== row.content_hash) throw new Error("Snapshot is corrupt");
      const decoded = decodeDurableBook(row.encoded);
      if (decoded.disposition !== "decoded") throw new Error("Snapshot could not be decoded");
      const head = JSON.parse(row.head) as NativeLedgerHead;
      this.snapshotSequence = BigInt(head.sequence);
      return { aggregate: decoded.aggregate, head };
    } catch {
      this.dropSnapshot();
      return null;
    }
  }

  private saveSnapshot(view: VerifiedView): void {
    const encoded = encodeDurableBook(view.aggregate);
    this.db
      .query(
        "INSERT OR REPLACE INTO app_read_snapshots (id, sequence, head, book_revision, encoded, content_hash) VALUES (1, ?, ?, ?, ?, ?)",
      )
      .run(
        view.head.sequence,
        JSON.stringify(view.head),
        view.head.bookRevision,
        encoded,
        snapshotHash(encoded),
      );
    this.snapshotSequence = BigInt(view.head.sequence);
    this.readStats.snapshotsWritten += 1;
  }

  private dropSnapshot(): void {
    if (!this.snapshotsEnabled) return;
    this.db.query("DELETE FROM app_read_snapshots WHERE id=1").run();
    this.snapshotSequence = -1n;
  }

  async reports(asOf: string, revision?: bigint, options?: ReportOptions) {
    const { aggregate } = await this.readAggregate(revision);
    return compileCoreReports(aggregate.state, asOf, options);
  }

  /** One account's lines in a range under a report's population (see reports/activity.ts). */
  async accountActivity(input: {
    accountId: string;
    asOf: string;
    revision?: bigint;
    populationHash?: string;
    from: string;
    to: string;
    page: number;
    reportFrom?: string;
  }) {
    const { aggregate } = await this.readAggregate(input.revision);
    return accountActivity(aggregate.state, input);
  }

  async journalEntry(
    id: string,
    revision: bigint,
    reportScope?: { asOf: string; populationHash: string; reportFrom?: string },
  ) {
    const { aggregate } = await this.readAggregate(revision);
    const state = aggregate.state;
    const view = bookView(state);
    const booked = view.find(id);
    if (!booked) throw new TypeError("Journal entry not found at this revision");
    if (reportScope) {
      verifyPopulation(state, reportScope);
      if (booked.journal.accountingDate > reportScope.asOf)
        throw new TypeError("Journal entry is outside this report's cutoff");
    }
    const chart = reportScope
      ? configurationAt(state, reportScope.asOf)
      : state.activeConfigurationSnapshot;
    const accountName = new Map(
      chart.admissionSnapshot.accounts.map((account) => [
        account.id,
        `${account.code} · ${account.name}`,
      ]),
    );
    const accountParts = new Map(
      chart.admissionSnapshot.accounts.map((account) => [
        account.id as string,
        { code: account.code, name: account.name },
      ]),
    );
    /** Whether the book holds this entry and it is dated on or before the report's cutoff. */
    const heldBy = (journalId: string, asOf: string): boolean => {
      const found = view.find(journalId);
      return found !== undefined && found.journal.accountingDate <= asOf;
    };
    const correction = linksOf(state.corrections)
      .naming([id])
      .find((link) => !reportScope || heldBy(link.correctionJournalId, reportScope.asOf));
    const sequenceOf = (journalId: string): string | undefined =>
      view.find(journalId)?.postingSequence.toString();
    return {
      id: booked.journal.id,
      kind: booked.journal.kind,
      date: booked.journal.accountingDate,
      narration: booked.journal.narration,
      recordedAt: booked.journal.recordedAt,
      postingSequence: booked.postingSequence.toString(),
      bookRevision: booked.bookRevision.toString(),
      viewedAtRevision: state.bookRevision.toString(),
      currency: state.identity.functionalCommodityId,
      correction: correction
        ? {
            kind: correction.kind,
            originalJournalId: correction.originalJournalId,
            correctionJournalId: correction.correctionJournalId,
            ...(sequenceOf(correction.originalJournalId) !== undefined
              ? { originalPostingSequence: sequenceOf(correction.originalJournalId) as string }
              : {}),
            ...(sequenceOf(correction.correctionJournalId) !== undefined
              ? { correctionPostingSequence: sequenceOf(correction.correctionJournalId) as string }
              : {}),
          }
        : null,
      ...(this.journalSource(booked, state) ? { source: this.journalSource(booked, state) } : {}),
      lines: booked.journal.postings.map((posting) => ({
        id: posting.id,
        accountId: posting.accountId,
        account: accountName.get(posting.accountId) ?? posting.accountId,
        ...(accountParts.has(posting.accountId as string)
          ? accountParts.get(posting.accountId as string)
          : {}),
        debit:
          posting.bookValue.amount.coefficient > 0n ? posting.bookValue.amount.toString() : "0.00",
        credit:
          posting.bookValue.amount.coefficient < 0n
            ? posting.bookValue.amount.negate().toString()
            : "0.00",
      })),
    };
  }

  /** The chart with balances and the tags in force on `asOf` (today, from the service clock, when
   * omitted). */
  async accounts(asOf?: string) {
    const setup = this.setupState();
    if (!setup) throw new Error("Book is not configured");
    const { aggregate } = await this.readAggregate();
    const state = aggregate.state;
    // Balances are read at the end of the book's calendar, so a book of several years, or one whose
    // fiscal year does not start in January, shows everything it holds (income and expense accounts
    // for the last fiscal year to date, as the trial balance does).
    const window = reportingWindow(state);
    const report = compileCoreReports(state, window.lastDate);
    const latestAccountingDate = ledgerView(state).latestJournalDate;
    const suggestedEffectiveOn = latestAccountingDate
      ? new Date(Date.parse(`${latestAccountingDate}T00:00:00Z`) + 86_400_000)
          .toISOString()
          .slice(0, 10)
      : calendarCoverage(state.periods).startsOn;
    const tagsAsOf = asOf ?? this.today();
    const tags = readAccountTags(this.db);
    return {
      currency: setup.currency,
      configurationRevision: state.configurationRevision.toString(),
      suggestedEffectiveOn,
      tagsAsOf,
      tagsRevision: String(tags.revision),
      tagsHash: tags.hash,
      accounts: state.admissionSnapshot.accounts.map((account) => ({
        id: account.id,
        tags: tags.tagsFor(account.id, tagsAsOf),
        code: account.code,
        name: account.name,
        role: account.role,
        parentId: account.parentId ?? null,
        openedOn: account.openedOn,
        closedOn: account.closedOn ?? null,
        balance:
          report.trialBalance.rows.find((row) => row.accountId === account.id)?.signedBalance ??
          "0.00",
      })),
    };
  }

  /** Seal, retain and prepare (or commit) one kernel command under a durable action identity.
   * Slices that issue their own commands (calendar, close) use this, never the ledger directly. */
  async executeAction(
    id: string,
    kind: string,
    request: unknown,
    build: (state: DurableBookAggregate["state"]) => BookCommand,
    prepareOnly = false,
    committer?: Committer,
  ): Promise<MutationReceipt | PreparedOperation> {
    const sealed = await this.retainAction(id, kind, request, build);
    return prepareOnly
      ? this.previewAction(id, kind, sealed)
      : this.commitAction(id, this.planHash(id, sealed), committer);
  }

  /** Seal one kernel command and retain its exact bytes under a durable action identity, without
   * previewing or submitting it. A repeat with the same identity and request returns the bytes
   * already retained (`build` is not called again); the same identity with another kind or request
   * is a conflict. A plan that is made of several commands, each sealed against the state the one
   * before leaves (the calendar lane's year-end), retains them one by one with this. */
  async retainAction(
    id: string,
    kind: string,
    request: unknown,
    build: (state: DurableBookAggregate["state"]) => BookCommand,
  ): Promise<string> {
    this.assertActionIdentity(id);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TypeError("Invalid action identity");
    const requestBody = JSON.stringify(request);
    const existing = this.db
      .query("SELECT kind, sealed_command, request_body FROM app_actions WHERE id=?")
      .get(id) as { kind: string; sealed_command: string; request_body: string | null } | null;
    if (existing && existing.kind !== kind)
      throw new ApplicationError("operation_identity_conflict", "Action identity was reused", 409);
    if (existing?.request_body && existing.request_body !== requestBody)
      throw new ApplicationError(
        "operation_identity_conflict",
        "Action identity was reused for different input",
        409,
      );
    if (!existing) {
      const { aggregate } = await this.readAggregate();
      const sealed = encodeBookCommand(build(aggregate.state));
      this.assertActionIdentity(id);
      this.db
        .query(
          "INSERT OR IGNORE INTO app_actions (id, kind, sealed_command, request_body) VALUES (?, ?, ?, ?)",
        )
        .run(id, kind, sealed, requestBody);
    }
    const row = this.db
      .query("SELECT kind, sealed_command, request_body FROM app_actions WHERE id=?")
      .get(id) as { kind: string; sealed_command: string; request_body: string | null };
    if (row.kind !== kind || row.request_body !== requestBody)
      throw new ApplicationError(
        "operation_identity_conflict",
        "Action identity was reused for different input",
        409,
      );
    return row.sealed_command;
  }

  async createAccount(
    input: {
      actionId: string;
      code: string;
      name: string;
      role: AccountSnapshot["role"];
      parentId?: string;
      effectiveOn: string;
    },
    prepareOnly = false,
    committer?: Committer,
  ) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(input.code) ||
      !input.name?.trim() ||
      input.name.length > 120 ||
      !["asset", "liability", "equity", "income", "expense", "gain", "unrealizedGain"].includes(
        input.role,
      )
    )
      throw new TypeError("Invalid account details");
    return this.executeAction(
      input.actionId,
      "createAccount",
      input,
      (state) => {
        if (
          state.admissionSnapshot.accounts.some(
            (account) => account.code.toLowerCase() === input.code.toLowerCase(),
          )
        )
          throw new TypeError("Account code already exists");
        const parent = input.parentId
          ? state.admissionSnapshot.accounts.find((account) => account.id === input.parentId)
          : undefined;
        if (input.parentId && !parent) throw new TypeError("Parent account does not exist");
        const now = instant(new Date().toISOString());
        const account: AccountSnapshot = {
          id: accountId(input.code.toLowerCase()),
          bookId: state.identity.bookId,
          code: input.code,
          name: input.name.trim(),
          role: input.role,
          normalSide: ["asset", "expense"].includes(input.role) ? "debit" : "credit",
          postingAllowed: true,
          openedOn: localDate(input.effectiveOn),
          ...(parent ? { parentId: parent.id } : {}),
          allowedCommodityIds: [],
        };
        return sealCommand({
          id: commandId(input.actionId),
          type: "replaceConfiguration",
          protocolVersion: version,
          bookId: state.identity.bookId,
          expectedBookRevision: state.bookRevision,
          expectedConfigurationRevision: state.configurationRevision,
          actorId: this.actor,
          issuedAt: now,
          completedAt: now,
          committedAt: now,
          effectiveOn: localDate(input.effectiveOn),
          periods: state.periods,
          admissionSnapshot: {
            ...state.admissionSnapshot,
            accounts: [...state.admissionSnapshot.accounts, account],
          },
          policies: state.policies,
          quantizationPolicies: state.quantizationPolicies,
          accountingPolicies: state.accountingPolicySnapshot.policies,
        });
      },
      prepareOnly,
      committer,
    );
  }

  /** Add several accounts in one configuration change, all open from `effectiveOn`. The change must come
   * after every entry, so it is for the time before the book has any: a history that brings accounts of its
   * own adds them here before it posts its first entry. */
  async createAccounts(
    input: {
      actionId: string;
      accounts: readonly { code: string; name: string; role: AccountSnapshot["role"] }[];
      effectiveOn: string;
    },
    committer?: Committer,
  ) {
    const roles = ["asset", "liability", "equity", "income", "expense"];
    for (const account of input.accounts)
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(account.code) ||
        !account.name?.trim() ||
        account.name.length > 120 ||
        !roles.includes(account.role)
      )
        throw new TypeError("Invalid account details");
    return this.executeAction(
      input.actionId,
      "createAccounts",
      input,
      (state) => {
        const taken = new Set(
          state.admissionSnapshot.accounts.map((account) => account.code.toLowerCase()),
        );
        for (const account of input.accounts) {
          if (taken.has(account.code.toLowerCase()))
            throw new TypeError("Account code already exists");
          taken.add(account.code.toLowerCase());
        }
        const added: AccountSnapshot[] = input.accounts.map((account) => ({
          id: accountId(account.code.toLowerCase()),
          bookId: state.identity.bookId,
          code: account.code,
          name: account.name.trim(),
          role: account.role,
          normalSide: ["asset", "expense"].includes(account.role) ? "debit" : "credit",
          postingAllowed: true,
          openedOn: localDate(input.effectiveOn),
          allowedCommodityIds: [],
        }));
        const now = instant(new Date().toISOString());
        return sealCommand({
          id: commandId(input.actionId),
          type: "replaceConfiguration",
          protocolVersion: version,
          bookId: state.identity.bookId,
          expectedBookRevision: state.bookRevision,
          expectedConfigurationRevision: state.configurationRevision,
          actorId: this.actor,
          issuedAt: now,
          completedAt: now,
          committedAt: now,
          effectiveOn: localDate(input.effectiveOn),
          periods: state.periods,
          admissionSnapshot: {
            ...state.admissionSnapshot,
            accounts: [...state.admissionSnapshot.accounts, ...added],
          },
          policies: state.policies,
          quantizationPolicies: state.quantizationPolicies,
          accountingPolicies: state.accountingPolicySnapshot.policies,
        });
      },
      false,
      committer,
    );
  }

  async changeAccount(
    input: {
      actionId: string;
      accountId: string;
      name: string;
      close: boolean;
      effectiveOn: string;
    },
    prepareOnly = false,
    committer?: Committer,
  ) {
    if (!input.name?.trim() || input.name.length > 120 || typeof input.close !== "boolean")
      throw new TypeError("Invalid account change");
    return this.executeAction(
      input.actionId,
      "changeAccount",
      input,
      (state) => {
        const existing = state.admissionSnapshot.accounts.find(
          (account) => account.id === input.accountId,
        );
        if (!existing) throw new TypeError("Account not found");
        if (existing.closedOn) throw new TypeError("Closed account cannot be changed");
        if (input.close) {
          const report = compileCoreReports(state, reportingWindow(state).lastDate);
          const balance = report.trialBalance.rows.find((row) => row.accountId === existing.id);
          if (balance?.signedBalance !== "0.00")
            throw new TypeError("An account with a balance cannot be closed");
        }
        const now = instant(new Date().toISOString());
        return sealCommand({
          id: commandId(input.actionId),
          type: "replaceConfiguration",
          protocolVersion: version,
          bookId: state.identity.bookId,
          expectedBookRevision: state.bookRevision,
          expectedConfigurationRevision: state.configurationRevision,
          actorId: this.actor,
          issuedAt: now,
          completedAt: now,
          committedAt: now,
          effectiveOn: localDate(input.effectiveOn),
          periods: state.periods,
          admissionSnapshot: {
            ...state.admissionSnapshot,
            accounts: state.admissionSnapshot.accounts.map((account) =>
              account.id === existing.id
                ? {
                    ...account,
                    name: input.name.trim(),
                    ...(input.close
                      ? { postingAllowed: false, closedOn: localDate(input.effectiveOn) }
                      : {}),
                  }
                : account,
            ),
          },
          policies: state.policies,
          quantizationPolicies: state.quantizationPolicies,
          accountingPolicies: state.accountingPolicySnapshot.policies,
        });
      },
      prepareOnly,
      committer,
    );
  }

  async reverseJournal(
    input: {
      actionId: string;
      journalId: string;
      accountingDate: string;
      reason: string;
    },
    prepareOnly = false,
    committer?: Committer,
  ) {
    if (!input.reason?.trim() || input.reason.length > 500)
      throw new TypeError("A correction reason is required");
    // The original is checked before the calendar grows for the reversal's date: an entry the book does
    // not have is an invalid input, not a reason to add a fiscal year.
    const { aggregate: current } = await this.readAggregate();
    if (!current.state.journals.some((item) => item.journal.id === input.journalId))
      throw new TypeError("Original journal was not found");
    if (!calendarCovers(current.state, input.accountingDate))
      await this.ensureCalendarCovers(
        input.accountingDate,
        "input.accountingDate",
        committer,
        input.actionId,
      );
    return this.executeAction(
      input.actionId,
      "reverseJournal",
      input,
      (state) => {
        const original = state.journals.find((item) => item.journal.id === input.journalId);
        if (!original) throw new TypeError("Original journal was not found");
        this.requirePostingDate(state, input.accountingDate, "input.accountingDate");
        const now = instant(new Date().toISOString());
        const originalJournal = original.journal;
        const journal: JournalTransaction = {
          id: journalId(input.actionId),
          kind: "reversing",
          bookId: state.identity.bookId,
          functionalCommodityId: state.identity.functionalCommodityId,
          economicAt: instant(`${input.accountingDate}T12:00:00Z`),
          accountingDate: localDate(input.accountingDate),
          recordedAt: now,
          // The original is named by its number, as a person reads it ("No. 23"): the number is permanent
          // and the entry's identifier says nothing to a reader.
          narration: `Reversal of No. ${original.postingSequence}: ${input.reason.trim()}`,
          postings: originalJournal.postings.map((posting, index) => ({
            ...posting,
            id: postingId(`${input.actionId}-${index}`),
            units: {
              ...posting.units,
              canonicalNumber: posting.units.canonicalNumber.negate(),
              ...(posting.units.sourceNumber
                ? { sourceNumber: posting.units.sourceNumber.negate() }
                : {}),
            },
            bookValue: {
              ...posting.bookValue,
              amount: posting.bookValue.amount.negate(),
            },
            ...(posting.costBasis
              ? {
                  costBasis: {
                    ...posting.costBasis,
                    totalBasis: posting.costBasis.totalBasis.negate(),
                    ...(posting.costBasis.sourceTotalBasis
                      ? { sourceTotalBasis: posting.costBasis.sourceTotalBasis.negate() }
                      : {}),
                  },
                }
              : {}),
          })),
        };
        const quantization = state.quantizationPolicies[0];
        const policy = state.policies[0];
        if (!quantization || !policy) throw new Error("Book policy unavailable");
        const derivation = {
          id: derivationId(`${input.actionId}-lineage`),
          policyId: policy.id,
          policyVersion: policy.version,
          algorithmVersion: version,
          inputHash: hashCanonical({
            originalJournalId: originalJournal.id,
            reason: input.reason.trim(),
          }),
          actorId: this.actor,
          state: "approved" as const,
          recordedAt: now,
          evidence: [
            {
              id: evidenceId(`${input.actionId}-evidence`),
              sourceSystem: "local-operator-review",
              sourceRecordId: originalJournal.id,
              observedAt: now,
              contentHash: original.canonicalHash,
            },
          ],
        };
        const resolved = resolveJournal(
          journal,
          state.policies,
          state.identity.ownerId,
          quantization,
          journal.postings.map((posting) => posting.bookValue.amount.toRational()),
          [derivation],
        );
        if (Array.isArray(resolved))
          throw new TypeError(resolved.map((item) => item.message).join("; "));
        return sealCommand({
          id: commandId(input.actionId),
          type: "correctJournal",
          protocolVersion: version,
          bookId: state.identity.bookId,
          expectedBookRevision: state.bookRevision,
          actorId: this.actor,
          issuedAt: now,
          completedAt: now,
          committedAt: now,
          correctionKind: "reversal",
          originalJournalId: originalJournal.id,
          resolved: resolved as ResolvedTransaction,
        });
      },
      prepareOnly,
      committer,
    );
  }

  /** Grow the calendar to cover a posting's date before the posting is sealed, so a book made this year
   * is posted to in January without anyone being asked to extend it first. The extension is the command
   * `periods.extend` seals (`replaceConfiguration`: every existing period unchanged, the new fiscal years
   * after them), committed under the poster's name so Changes says who extended it and through what, in
   * steps of at most ten fiscal years each, through the fiscal year the date belongs to. A date before the
   * book's first day, or past fiscal year 2100, cannot be covered and is refused with
   * `calendar_not_configured` as before. Nothing is done when the calendar already covers the date, which
   * is what makes a retried request safe. */
  async ensureCalendarCovers(
    date: string,
    field: string,
    committer?: Committer,
    operationId?: string,
  ): Promise<void> {
    const setup = this.setupState();
    if (!setup) return;
    const changes = committer ? changesState(this) : null;
    // From the earliest first year to the last supported one is ten steps of ten; one more reads a calendar
    // another request grew meanwhile.
    for (let step = 0; step < 12; step += 1) {
      const { aggregate } = await this.readAggregate();
      const state = aggregate.state;
      if (calendarCovers(state, date)) return;
      const shape = ledgerShape(state, setup);
      const through = extendThroughFor(state, shape, date);
      if (through === null) {
        // Before the first day, or past the last year the calendar can reach: the error says which.
        requireCalendarDate(state, shape, date, field);
        return;
      }
      const plan = planExtension(
        state,
        shape,
        setup.fiscalYear,
        Math.min(through, fiscalYearRange(state).last + MAX_EXTENSION_YEARS),
      );
      const command = extendCalendarCommand(
        state,
        {
          actionId: `extend-${operationId ?? crypto.randomUUID()}-${plan.through}-${step}`,
          actor: this.actor,
        },
        plan,
      );
      if (changes && committer) changes.recordCommit(command.id, committer, this.now());
      const receipt = await this.ledger.execute(await this.credential(), command);
      this.noteHead(receipt.head);
      const original = receipt.value.originalResult ?? receipt.value.result;
      if (original.disposition === "committed") continue;
      // The book moved on under the command, perhaps because another request grew the calendar itself: what
      // it covers now is read again, and a calendar that still ends short is said, with the book's reason.
      const { aggregate: again } = await this.readAggregate();
      if (calendarCovers(again.state, date)) return;
      const reasons =
        original.disposition === "rejected"
          ? original.diagnostics.map((diagnostic) => diagnostic.message)
          : [];
      throw new ApplicationError(
        "calendar_not_extended",
        `The calendar could not be extended through fiscal year ${plan.through} to cover ${date}${reasons.length > 0 ? `: ${reasons.join("; ")}` : "."}`,
        409,
        [{ path: field, message: `${date} is not covered by a fiscal period` }],
      );
    }
    const { aggregate } = await this.readAggregate();
    requireCalendarDate(aggregate.state, ledgerShape(aggregate.state, setup), date, field);
  }

  /** A posting date must fall inside the book's fiscal calendar and on or after the day the books began.
   * The posting paths grow the calendar first (`ensureCalendarCovers`), so what this refuses with
   * `calendar_not_configured` is a date before the first day or past the last year the calendar can reach,
   * named with the covered range, instead of reaching the kernel and coming back as a bare period
   * diagnostic. */
  private requirePostingDate(state: BookState, date: string, field: string): void {
    const setup = this.setupState();
    if (!setup) return;
    requireCalendarDate(state, ledgerShape(state, setup), date, field);
    const start = postingFloor(this);
    if (start !== null && date < start.floor)
      throw new ApplicationError(
        "before_books_began",
        `${date} is before the day the books began, ${start.began}. To bring in earlier years, move the start date back first.`,
        409,
        [{ path: field, message: `${date} is before ${start.began}` }],
      );
  }

  /** The fiscal calendar and its periods: each period's fiscal year, status and consequences, each
   * fiscal year's progress, whether the calendar can be extended, and the close and reopen history.
   * "Today" for whether a period has ended is read from the service clock. `inboxDates`, the days the
   * Inbox's bank transactions are dated on, lets a period say nothing is recorded in it (`empty`); the
   * calendar slice reads them, and without them no period is called empty. */
  async periods(inboxDates: readonly string[] | null = null) {
    const setup = this.setupState();
    if (!setup) throw new Error("Book is not configured");
    const { aggregate } = await this.readAggregate();
    return periodList(
      aggregate.state,
      ledgerShape(aggregate.state, setup),
      this.today(),
      booksBeganOn(this),
      inboxDates,
    );
  }

  async changePeriod(
    input: {
      actionId: string;
      periodId: string;
      operation: "close" | "reopen";
      reason: string;
    },
    prepareOnly = false,
    committer?: Committer,
  ) {
    if (!input.reason?.trim() || input.reason.length > 500)
      throw new TypeError("A period change reason is required");
    return this.executeAction(
      input.actionId,
      `${input.operation}Period`,
      input,
      (state) => {
        const context = { actionId: input.actionId, actor: this.actor };
        return input.operation === "reopen"
          ? reopenPeriodCommand(state, context, input.periodId, input.reason)
          : closePeriodCommand(state, context, input.periodId, input.reason);
      },
      prepareOnly,
      committer,
    );
  }

  private sourceJournalId(sourceId: string): string {
    return `source-${hashCanonical({ type: "ApplicationSourceJournal", bookId: this.bookId, sourceId }).digest}`;
  }

  private registerSource(source: SourceEvent): void {
    const digest = sourceHash(source).digest;
    const row = this.db.query("SELECT content_hash FROM app_sources WHERE id=?").get(source.id) as {
      content_hash: string;
    } | null;
    if (row && row.content_hash !== digest)
      throw new ApplicationError(
        "source_identity_conflict",
        "Source ID already identifies different source facts. Inspect the retained source; do not substitute another ID to bypass this conflict.",
        409,
      );
    this.db
      .query("INSERT OR IGNORE INTO app_sources (id, body, content_hash) VALUES (?, ?, ?)")
      .run(source.id, JSON.stringify(source), digest);
  }

  private sourceFacts(row: SourceRow): SourceEvent {
    const source = JSON.parse(row.body) as SourceEvent;
    if (source?.id !== row.id || sourceHash(source).digest !== row.content_hash)
      throw new ApplicationError(
        "source_record_corrupt",
        "Retained source facts failed integrity verification",
        503,
      );
    return source;
  }

  private async sourcePostingOwner(
    source: SourceEvent,
    operationId: string,
  ): Promise<string | null> {
    const row = this.db
      .query("SELECT id, body, content_hash, posting_operation_id FROM app_sources WHERE id=?")
      .get(source.id) as SourceRow | null;
    if (!row || row.content_hash !== sourceHash(source).digest)
      throw new ApplicationError(
        "source_identity_conflict",
        "Retained source facts do not match this proposal",
        409,
      );
    this.sourceFacts(row);
    if (!row.posting_operation_id || row.posting_operation_id === operationId)
      return row.posting_operation_id;
    const owner = await this.operation(row.posting_operation_id);
    if (owner.disposition === "rejected") return row.posting_operation_id;
    throw new ApplicationError(
      owner.disposition === "committed" ? "source_already_posted" : "source_posting_unresolved",
      owner.disposition === "committed"
        ? "This source is already posted. Inspect its journal and use an explicit linked correction."
        : "Another operation owns this source's uncertain posting. Inspect or retry that original operation; do not create a replacement.",
      409,
      [
        { path: "sourceId", message: source.id },
        { path: "operationId", message: row.posting_operation_id },
        { path: "journalId", message: this.sourceJournalId(source.id) },
      ],
    );
  }

  private journalSource(booked: BookedJournal, state: DurableBookAggregate["state"]) {
    const link = linksOf(state.corrections).firstByCorrection(booked.journal.id);
    const original = link ? bookView(state).find(link.originalJournalId) : booked;
    const evidence = original?.derivations
      .flatMap((item) => item.evidence)
      .find((item) => item.sourceSystem === "rastrata-source-v1");
    return evidence && original
      ? {
          id: evidence.sourceRecordId,
          contentHash: evidence.contentHash.digest,
          originalJournalId: original.journal.id,
        }
      : undefined;
  }

  private async sourceSummary(row: SourceRow, state: DurableBookAggregate["state"]) {
    const journalId = this.sourceJournalId(row.id);
    const booked = bookView(state).find(journalId);
    const source = this.sourceFacts(row);
    if (booked && this.journalSource(booked, state)?.contentHash !== row.content_hash)
      throw new ApplicationError(
        "source_identity_conflict",
        "Source facts conflict with the immutable posted journal",
        409,
      );
    const ownerId = booked?.commandId ?? row.posting_operation_id;
    const owner = ownerId ? await this.operation(ownerId) : null;
    return {
      source,
      contentHash: row.content_hash,
      journalId,
      bookRevision: state.bookRevision.toString(),
      status: booked
        ? ("posted" as const)
        : owner?.disposition === "rejected"
          ? ("rejected" as const)
          : owner
            ? ("posting" as const)
            : ("unposted" as const),
      ...(booked
        ? { postingOperationId: booked.commandId }
        : row.posting_operation_id
          ? { postingOperationId: row.posting_operation_id }
          : {}),
      ...(owner?.outcomeSequence && (booked || owner.disposition === "rejected")
        ? { outcomeSequence: owner.outcomeSequence }
        : {}),
    };
  }

  async source(id: string, page = 1) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw new TypeError("Invalid source page");
    const row = this.db
      .query("SELECT id, body, content_hash, posting_operation_id FROM app_sources WHERE id=?")
      .get(id) as SourceRow | null;
    if (!row) throw new ApplicationError("source_not_found", "Source event not found", 404);
    const { aggregate } = await this.readAggregate();
    const summary = await this.sourceSummary(row, aggregate.state);
    const count = (
      this.db
        .query("SELECT COUNT(*) AS count FROM app_drafts WHERE json_extract(body, '$.source.id')=?")
        .get(id) as { count: number }
    ).count;
    const rows = this.db
      .query(
        "SELECT id FROM app_drafts WHERE json_extract(body, '$.source.id')=? ORDER BY rowid DESC LIMIT 25 OFFSET ?",
      )
      .all(id, (page - 1) * 25) as { id: string }[];
    return {
      ...summary,
      drafts: {
        count,
        page,
        pageSize: 25,
        drafts: rows.map((item) => {
          const draft = this.draft(item.id);
          if (!draft) throw new Error("Source draft missing");
          return { id: draft.id, version: draft.version, status: draft.status };
        }),
      },
      corrections: aggregate.state.corrections.filter(
        (item) => item.originalJournalId === summary.journalId,
      ),
    };
  }

  async sources(page = 1, text = "") {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw new TypeError("Invalid source page");
    const pattern = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    const count = (
      this.db
        .query(
          "SELECT COUNT(*) AS count FROM app_sources WHERE id LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'",
        )
        .get(pattern, pattern) as { count: number }
    ).count;
    const rows = this.db
      .query(
        "SELECT id, body, content_hash, posting_operation_id FROM app_sources WHERE id LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' ORDER BY rowid DESC LIMIT 25 OFFSET ?",
      )
      .all(pattern, pattern, (page - 1) * 25) as SourceRow[];
    const { aggregate } = await this.readAggregate();
    return {
      count,
      page,
      pageSize: 25,
      sources: await Promise.all(rows.map((row) => this.sourceSummary(row, aggregate.state))),
    };
  }

  draft(id: string): SavedDraft | null {
    const row = this.db
      .query(
        "SELECT id, version, status, body, rejected, sealed_command, outcome_sequence, recovered_from_operation_id FROM app_drafts WHERE id=?",
      )
      .get(id) as {
      id: string;
      version: number;
      status: "draft" | "posting" | "posted";
      body: string;
      rejected: number;
      sealed_command: string | null;
      outcome_sequence: string | null;
      recovered_from_operation_id: string | null;
    } | null;
    const decoded = row?.sealed_command ? decodeBookCommand(row.sealed_command) : null;
    if (decoded && decoded.disposition !== "decoded")
      throw new Error("Stored draft command is invalid");
    const data = row ? (JSON.parse(row.body) as JournalDraftData) : null;
    return row && data
      ? {
          id: row.id,
          version: row.version,
          status: row.rejected ? "rejected" : row.status,
          data,
          ...(data.source ? { journalId: this.sourceJournalId(data.source.id) } : {}),
          ...(decoded?.disposition === "decoded" ? { postingOperationId: decoded.command.id } : {}),
          ...(row.outcome_sequence ? { outcomeSequence: row.outcome_sequence } : {}),
          ...(row.recovered_from_operation_id
            ? { recoveredFromOperationId: row.recovered_from_operation_id }
            : {}),
        }
      : null;
  }

  listDrafts(): SavedDraft[] {
    const rows = this.db
      .query("SELECT id FROM app_drafts WHERE status IN ('draft', 'posting') ORDER BY rowid DESC")
      .all() as { id: string }[];
    return rows.flatMap((row) => {
      const draft = this.draft(row.id);
      return draft ? [draft] : [];
    });
  }

  draftPage(page: number) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw new TypeError("Invalid draft page");
    const pageSize = 25;
    const count = (
      this.db
        .query("SELECT COUNT(*) AS count FROM app_drafts WHERE status IN ('draft', 'posting')")
        .get() as { count: number }
    ).count;
    const rows = this.db
      .query(
        "SELECT id FROM app_drafts WHERE status IN ('draft', 'posting') ORDER BY rowid DESC LIMIT ? OFFSET ?",
      )
      .all(pageSize, (page - 1) * pageSize) as { id: string }[];
    return {
      count,
      page,
      pageSize,
      drafts: rows.flatMap((row) => {
        const draft = this.draft(row.id);
        return draft ? [draft] : [];
      }),
    };
  }

  /** What a person typed as the reference of every posted entry, by the id of the journal it became, read from
   * the whole table of drafts. The draft of an entry typed in has the entry's id; the draft of an entry that came
   * from a source is known by that source, and the entry's id is made from it. */
  private postedReferences(): ReadonlyMap<string, string> {
    const rows = this.db.query("SELECT id, body FROM app_drafts WHERE status='posted'").all() as {
      id: string;
      body: string;
    }[];
    return new Map(
      rows.map((row) => {
        const data = JSON.parse(row.body) as JournalDraftData;
        return [data.source ? this.sourceJournalId(data.source.id) : row.id, data.reference];
      }),
    );
  }

  /** What a person typed as the reference of one posted entry, from the same table and by the same rule as
   * `postedReferences`, found by the indexes of the table and not by reading it: the draft with the entry's id,
   * and the draft of the source the entry says it came from. When more than one draft is the entry's, the later
   * wins, as it does there. */
  private postedReference(booked: BookedJournal): string | undefined {
    const id = booked.journal.id as string;
    let latest: { rowid: number; reference: string } | undefined;
    const consider = (row: { rowid: number; id: string; body: string } | null): void => {
      if (row === null || (latest !== undefined && latest.rowid > row.rowid)) return;
      const data = JSON.parse(row.body) as JournalDraftData;
      if ((data.source ? this.sourceJournalId(data.source.id) : row.id) === id)
        latest = { rowid: row.rowid, reference: data.reference };
    };
    consider(
      this.db
        .query("SELECT rowid, id, body FROM app_drafts WHERE id = ? AND status = 'posted'")
        .get(id) as { rowid: number; id: string; body: string } | null,
    );
    const evidence = booked.derivations
      .flatMap((item) => item.evidence)
      .find((item) => item.sourceSystem === "rastrata-source-v1");
    if (evidence)
      consider(
        this.db
          .query(
            "SELECT rowid, id, body FROM app_drafts WHERE status = 'posted' AND json_extract(body, '$.source.id') = ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(evidence.sourceRecordId) as { rowid: number; id: string; body: string } | null,
      );
    return latest?.reference;
  }

  async journalBook(
    query: {
      page: number;
      text: string;
      from: string;
      to: string;
      accountId: string;
      status: string;
      type?: string;
      revision?: bigint;
    } = { page: 1, text: "", from: "", to: "", accountId: "", status: "" },
  ) {
    if (!Number.isSafeInteger(query.page) || query.page < 1 || query.page > 100000)
      throw new TypeError("Invalid journal page");
    const setup = this.setupState();
    if (!setup) throw new Error("Book is not configured");
    const { aggregate, head } = await this.readAggregate(query.revision);
    const population = compileCoreReports(
      aggregate.state,
      reportingWindow(aggregate.state).lastDate,
    );
    const accounts = aggregate.state.admissionSnapshot.accounts.map((account) => ({
      value: account.id,
      label: `${account.code} · ${account.name}`,
      path: account.parentId ?? account.role,
      group: account.role,
      code: account.code,
      name: account.name,
      ...(account.closedOn ? { disabled: true, reason: "Closed account" } : {}),
    }));
    const accountLabel = new Map<string, string>(
      accounts.map((account) => [account.value, account.label]),
    );
    const drafts = this.listDrafts();
    // A search by words looks at what was typed as the reference of every entry in the dates asked for, which is
    // read from the whole table of drafts; a page asks for the entries on it only.
    const everyReference = query.text ? this.postedReferences() : undefined;
    const found = journalBookPage({
      state: aggregate.state,
      view: bookView(aggregate.state),
      drafts,
      referenceOf: everyReference
        ? (booked) => everyReference.get(booked.journal.id)
        : (booked) => this.postedReference(booked),
      accountLabel,
      query,
    });
    return {
      head,
      scope: {
        revision: population.bookRevision,
        asOf: population.asOf,
        populationHash: population.populationHash,
        basis: population.basis,
        currency: population.currency,
        compilerVersion: population.compilerVersion,
      },
      context: {
        bookName: setup.name,
        currency: setup.currency,
        description: "Persisted book entries",
        savedMessage: "Draft saved",
      },
      accounts,
      entries: found.entries,
      count: found.count,
      page: query.page,
      pageSize: JOURNAL_PAGE_SIZE,
      drafts: found.drafts,
      corrections: found.corrections,
    };
  }

  createDraft(data: JournalDraftData): SavedDraft {
    this.validateDraftShape(data);
    if (!this.setupState()) throw new Error("Book is not configured");
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      if (data.source) this.registerSource(data.source);
      this.db
        .query("INSERT INTO app_drafts (id, version, status, body) VALUES (?, 1, 'draft', ?)")
        .run(id, JSON.stringify(data));
    });
    const result = this.draft(id);
    if (!result) throw new Error("Draft was not retained");
    return result;
  }

  async recoverDraft(
    id: string,
    expectedVersion: number,
    postingOperationId: string,
    operationId: string,
  ): Promise<SavedDraft> {
    this.assertOperationIdentity(operationId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new TypeError("Invalid draft version");
    const outcome = await this.operation(postingOperationId);
    if (outcome.disposition !== "rejected")
      throw new ApplicationError(
        "draft_recovery_unavailable",
        outcome.disposition === "unresolved"
          ? "The posting result is uncertain. Inspect or retry the original posting; do not create a new attempt."
          : "Only a durably rejected posting can be recovered for editing",
        409,
      );
    const action = this.db
      .query("SELECT kind, sealed_command, request_body FROM app_actions WHERE id=?")
      .get(postingOperationId) as {
      kind: string;
      sealed_command: string;
      request_body: string;
    };
    const postingRequest = JSON.stringify({ draftId: id, draftVersion: expectedVersion });
    if (action.kind !== "postDraft" || action.request_body !== postingRequest)
      throw new ApplicationError(
        "draft_operation_conflict",
        "The rejected posting does not belong to this draft version",
        409,
      );
    // The draft transition and its exact response are retained in one product
    // transaction. Identical retries cannot reopen the draft a second time.
    return this.retainRequest(
      operationId,
      "drafts.recover",
      { draftId: id, expectedVersion, postingOperationId },
      () => {
        const updated = this.db
          .query(
            "UPDATE app_drafts SET version=version+1, status='draft', rejected=0, sealed_command=NULL, outcome_sequence=NULL, recovered_from_operation_id=? WHERE id=? AND version=? AND status='posting' AND sealed_command=?",
          )
          .run(postingOperationId, id, expectedVersion, action.sealed_command);
        if (updated.changes !== 1)
          throw new ApplicationError(
            "draft_version_conflict",
            "Draft changed or no longer owns the rejected posting",
            409,
          );
        const recovered = this.draft(id);
        if (!recovered) throw new Error("Recovered draft was not retained");
        return recovered;
      },
    );
  }

  saveDraft(id: string, expectedVersion: number, data: JournalDraftData): SavedDraft {
    this.validateDraftShape(data);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new TypeError("Invalid draft version");
    this.db.transaction(() => {
      if (data.source) this.registerSource(data.source);
      const result = this.db
        .query(
          "UPDATE app_drafts SET version=version+1, body=? WHERE id=? AND version=? AND status='draft'",
        )
        .run(JSON.stringify(data), id, expectedVersion);
      if (result.changes !== 1) throw new Error("Draft changed or is no longer editable");
    });
    const draft = this.draft(id);
    if (!draft) throw new Error("Draft was not retained");
    return draft;
  }

  discardDraft(id: string, expectedVersion: number): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new TypeError("Invalid draft version");
    const result = this.db
      .query("DELETE FROM app_drafts WHERE id=? AND version=? AND status='draft'")
      .run(id, expectedVersion);
    if (result.changes !== 1) throw new Error("Draft changed or is no longer editable");
  }

  private validateDraftShape(data: JournalDraftData): void {
    if (
      data.source &&
      (typeof data.source.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(data.source.id) ||
        typeof data.source.description !== "string" ||
        !data.source.description.trim() ||
        data.source.description.length > 1000 ||
        (data.source.evidenceReference !== undefined &&
          (typeof data.source.evidenceReference !== "string" ||
            data.source.evidenceReference.length > 1000)) ||
        Object.keys(data.source).some(
          (key) => !["id", "description", "evidenceReference"].includes(key),
        ))
    )
      throw new TypeError("Invalid source event");
    if (
      !data ||
      typeof data.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
      typeof data.reference !== "string" ||
      data.reference.length > 80 ||
      typeof data.narration !== "string" ||
      data.narration.length > 1000 ||
      !Array.isArray(data.lines) ||
      data.lines.length < 2 ||
      data.lines.length > 100 ||
      data.lines.some(
        (line) =>
          !line ||
          typeof line.accountId !== "string" ||
          typeof line.debit !== "string" ||
          typeof line.credit !== "string" ||
          line.debit.length > 40 ||
          line.credit.length > 40,
      )
    )
      throw new TypeError("Invalid journal draft");
  }

  private async sealedPosting(
    draft: SavedDraft,
    operationId = draft.id,
    committer?: Committer,
  ): Promise<string> {
    let { aggregate } = await this.readAggregate();
    if (!calendarCovers(aggregate.state, draft.data.date)) {
      await this.ensureCalendarCovers(draft.data.date, "input.data.date", committer, operationId);
      ({ aggregate } = await this.readAggregate());
    }
    const state = aggregate.state;
    this.requirePostingDate(state, draft.data.date, "input.data.date");
    const currency = state.identity.functionalCommodityId;
    const financialId = draft.data.source ? this.sourceJournalId(draft.data.source.id) : draft.id;
    // Only an entry from a source can already be in the book under this id; an entry typed in is new.
    const existing = draft.data.source ? bookView(state).find(financialId) : undefined;
    if (draft.data.source && existing) {
      const proof = this.journalSource(existing, state);
      throw new ApplicationError(
        proof?.contentHash !== sourceHash(draft.data.source).digest
          ? "source_identity_conflict"
          : "source_already_posted",
        "This source already has a retained journal. Inspect it and use an explicit linked correction.",
        409,
        [
          { path: "journalId", message: financialId },
          { path: "operationId", message: existing.commandId },
        ],
      );
    }
    const parseAmount = (amount: string): bigint => {
      if (!amount) return 0n;
      if (!/^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/.test(amount))
        throw new TypeError("Use exact two-decimal amounts");
      const [whole, fraction] = amount.split(".");
      if (whole === undefined || fraction === undefined) throw new TypeError("Invalid amount");
      return BigInt(whole) * 100n + BigInt(fraction);
    };
    let total = 0n;
    const postings = draft.data.lines.map((line, index) => {
      const debit = parseAmount(line.debit),
        credit = parseAmount(line.credit);
      if (debit > 0n === credit > 0n)
        throw new ApplicationError(
          "journal_line_invalid",
          "Each line needs one debit or credit",
          400,
          [{ path: `input.data.lines[${index}]`, message: "Enter one positive debit or credit" }],
        );
      const amount = debit - credit;
      total += amount;
      return {
        id: postingId(`${financialId}-${index}`),
        ordinal: BigInt(index),
        accountId: accountId(line.accountId),
        units: { canonicalNumber: ExactRational.of(amount, 100n), commodityId: currency },
        bookValue: { amount: ExactDecimal.of(amount, 2n), functionalCommodityId: currency },
        dimensionMemberIds: [],
      };
    });
    if (total !== 0n)
      throw new ApplicationError("journal_unbalanced", "Debits and credits must balance", 400, [
        { path: "input.data.lines", message: "Debits and credits must balance" },
      ]);
    const now = new Date().toISOString();
    const journal: JournalTransaction = {
      id: journalId(financialId),
      kind: "ordinary",
      bookId: state.identity.bookId,
      functionalCommodityId: currency,
      economicAt: instant(`${draft.data.date}T12:00:00Z`),
      accountingDate: localDate(draft.data.date),
      recordedAt: instant(now),
      narration: draft.data.narration.trim() || draft.data.reference.trim() || "Journal entry",
      postings,
    };
    const quantization = state.quantizationPolicies[0];
    if (!quantization) throw new Error("Book has no quantization policy");
    const policy = state.policies[0];
    if (!policy) throw new Error("Book has no booking policy");
    const derivations = draft.data.source
      ? [
          {
            id: derivationId(`${operationId}-source`),
            policyId: policy.id,
            policyVersion: policy.version,
            algorithmVersion: version,
            inputHash: sourceHash(draft.data.source),
            actorId: this.actor,
            state: "approved" as const,
            recordedAt: instant(now),
            evidence: [
              {
                id: evidenceId(`${operationId}-source`),
                sourceSystem: "rastrata-source-v1",
                sourceRecordId: draft.data.source.id,
                observedAt: instant(now),
                contentHash: sourceHash(draft.data.source),
              },
            ],
          },
        ]
      : [];
    const resolved = resolveJournal(
      journal,
      state.policies,
      state.identity.ownerId,
      quantization,
      postings.map((posting) => posting.bookValue.amount.toRational()),
      derivations,
    );
    if (Array.isArray(resolved))
      throw new TypeError(resolved.map((item) => item.message).join("; "));
    const command = sealCommand({
      id: commandId(operationId),
      type: "postJournal",
      protocolVersion: version,
      bookId: state.identity.bookId,
      expectedBookRevision: state.bookRevision,
      actorId: this.actor,
      issuedAt: instant(now),
      completedAt: instant(now),
      committedAt: instant(now),
      resolved: resolved as ResolvedTransaction,
    });
    return encodeBookCommand(command);
  }

  async postDraft(
    id: string,
    committer?: Committer,
  ): Promise<{
    disposition: string;
    outcomeSequence: string | null;
    diagnostics: readonly string[];
  }> {
    const draft = this.draft(id);
    if (!draft) throw new Error("Draft not found");
    const row = this.db
      .query("SELECT sealed_command, outcome_sequence FROM app_drafts WHERE id=?")
      .get(id) as { sealed_command: string | null; outcome_sequence: string | null } | null;
    if (!row) throw new Error("Draft not found");
    if (draft.status === "posted")
      return { disposition: "committed", outcomeSequence: row.outcome_sequence, diagnostics: [] };
    let sealed = row.sealed_command;
    if (!sealed) {
      sealed = await this.sealedPosting(
        draft,
        draft.recoveredFromOperationId ? crypto.randomUUID() : draft.id,
        committer,
      );
    }
    const operationId = this.retainDraftCommand(draft.id, draft.version, sealed);
    const receipt = await this.commitAction(
      operationId,
      this.planHash(operationId, sealed),
      committer,
    );
    return {
      disposition: receipt.disposition,
      outcomeSequence: receipt.outcomeSequence,
      diagnostics: receipt.diagnostics,
    };
  }

  /** Move the day the books begin back to `date`, when that is earlier than it is now. The calendar
   * already reaches back to the book's first fiscal year; this is the fact that the books hold entries
   * from there, which lowers the floor an entry may be dated at. A book whose setup names no such day has
   * its calendar for its limit and nothing to move. */
  moveBooksStartBack(date: string): void {
    const row = this.db
      .query("SELECT setup FROM app_book WHERE id=1 AND status='active'")
      .get() as { setup: string } | null;
    if (!row) return;
    const stored = JSON.parse(row.setup) as BookSetup & { [CURRENT_START_KEY]?: string };
    const current = stored[CURRENT_START_KEY] ?? stored.booksStartOn;
    if (current === undefined || date >= current) return;
    this.db
      .query("UPDATE app_book SET setup=? WHERE id=1")
      .run(JSON.stringify({ ...stored, [CURRENT_START_KEY]: date }));
  }

  /** Keep that a history was brought into this book, which the setup checklist reads: the books begin with
   * entries, so opening balances are not a step that is left. */
  markHistoryImported(): void {
    const row = this.db
      .query("SELECT setup FROM app_book WHERE id=1 AND status='active'")
      .get() as { setup: string } | null;
    if (!row) return;
    const stored = JSON.parse(row.setup) as Record<string, unknown>;
    if (stored[HISTORY_KEY] === true) return;
    this.db
      .query("UPDATE app_book SET setup=? WHERE id=1")
      .run(JSON.stringify({ ...stored, [HISTORY_KEY]: true }));
  }

  /** Whether a history was brought into this book. */
  historyImported(): boolean {
    const row = this.db
      .query("SELECT setup FROM app_book WHERE id=1 AND status='active'")
      .get() as { setup: string } | null;
    return row !== null && (JSON.parse(row.setup) as Record<string, unknown>)[HISTORY_KEY] === true;
  }

  /** Post entries that come from a source, many at a time, straight through the ledger.
   *
   * Posting one draft at a time reads the book before every entry; a history of tens of thousands of
   * entries cannot be posted that way, so this reads it once and sends each entry as the next command, the
   * way the draft path does for one: the same journal, the same provenance (the source's identity and
   * content hash), the same record of who posted it. An entry whose source is already in the book is not
   * posted again, which is what makes a retried call safe. It stops at the first entry the book refuses and
   * says which. */
  async postSourced(
    entries: readonly SourcedEntry[],
    committer?: Committer,
  ): Promise<{
    posted: number;
    skipped: number;
    failed: { index: number; code: string; message: string } | null;
  }> {
    const changes = committer ? changesState(this) : null;
    let { aggregate } = await this.readAggregate();
    let state = aggregate.state;
    const currency = state.identity.functionalCommodityId;
    const quantization = state.quantizationPolicies[0];
    const policy = state.policies[0];
    if (!quantization || !policy) throw new Error("Book has no policy");
    let view = bookView(state);
    let revision = state.bookRevision;
    let posted = 0;
    let skipped = 0;
    for (const [index, entry] of entries.entries()) {
      try {
        if (!calendarCovers(state, entry.date)) {
          // The calendar grows to cover the entry; the book is read again, and the next command expects
          // the revision the extension left.
          await this.ensureCalendarCovers(
            entry.date,
            `entries[${index}].date`,
            committer,
            `import-${this.sourceJournalId(entry.source.id)}`,
          );
          ({ aggregate } = await this.readAggregate());
          state = aggregate.state;
          view = bookView(state);
          revision = state.bookRevision;
        }
        this.requirePostingDate(state, entry.date, `entries[${index}].date`);
      } catch (cause) {
        if (cause instanceof ApplicationError)
          return { posted, skipped, failed: { index, code: cause.code, message: cause.message } };
        throw cause;
      }
      const financialId = this.sourceJournalId(entry.source.id);
      if (view.find(financialId)) {
        skipped += 1;
        continue;
      }
      let total = 0n;
      const postings = entry.lines.map((line, ordinal) => {
        const amount = line.debit - line.credit;
        total += amount;
        return {
          id: postingId(`${financialId}-${ordinal}`),
          ordinal: BigInt(ordinal),
          accountId: accountId(line.accountId),
          units: { canonicalNumber: ExactRational.of(amount, 100n), commodityId: currency },
          bookValue: { amount: ExactDecimal.of(amount, 2n), functionalCommodityId: currency },
          dimensionMemberIds: [],
        };
      });
      if (total !== 0n)
        return {
          posted,
          skipped,
          failed: { index, code: "journal_unbalanced", message: "Debits and credits must balance" },
        };
      const now = new Date().toISOString();
      const contentHash = sourceHash(entry.source);
      const resolved = resolveJournal(
        {
          id: journalId(financialId),
          kind: "ordinary",
          bookId: state.identity.bookId,
          functionalCommodityId: currency,
          economicAt: instant(`${entry.date}T12:00:00Z`),
          accountingDate: localDate(entry.date),
          recordedAt: instant(now),
          narration: entry.narration.trim() || entry.reference.trim() || "Journal entry",
          postings,
        },
        state.policies,
        state.identity.ownerId,
        quantization,
        postings.map((posting) => posting.bookValue.amount.toRational()),
        [
          {
            id: derivationId(`${financialId}-source`),
            policyId: policy.id,
            policyVersion: policy.version,
            algorithmVersion: version,
            inputHash: contentHash,
            actorId: this.actor,
            state: "approved" as const,
            recordedAt: instant(now),
            evidence: [
              {
                id: evidenceId(`${financialId}-source`),
                sourceSystem: "rastrata-source-v1",
                sourceRecordId: entry.source.id,
                observedAt: instant(now),
                contentHash,
              },
            ],
          },
        ],
      );
      if (Array.isArray(resolved))
        return {
          posted,
          skipped,
          failed: {
            index,
            code: "journal_invalid",
            message: resolved.map((item) => item.message).join("; "),
          },
        };
      const command = sealCommand({
        id: commandId(`import-${financialId}`),
        type: "postJournal",
        protocolVersion: version,
        bookId: state.identity.bookId,
        expectedBookRevision: revision,
        actorId: this.actor,
        issuedAt: instant(now),
        completedAt: instant(now),
        committedAt: instant(now),
        resolved: resolved as ResolvedTransaction,
      });
      if (committer && changes) changes.recordCommit(command.id, committer, this.now());
      const receipt = await this.ledger.execute(await this.credential(), command);
      this.noteHead(receipt.head);
      const original = receipt.value.originalResult ?? receipt.value.result;
      if (original.disposition !== "committed") {
        const first = original.disposition === "rejected" ? original.diagnostics[0] : undefined;
        return {
          posted,
          skipped,
          failed: {
            index,
            code: first?.code ?? "rejected",
            message: first?.message ?? "The book did not accept the entry.",
          },
        };
      }
      revision += 1n;
      posted += 1;
    }
    return { posted, skipped, failed: null };
  }

  close(): void {
    // Save what has been verified since the last snapshot, so the next start replays little.
    // Never let a failed save keep the database open.
    try {
      if (
        this.savingSnapshots &&
        this.view &&
        BigInt(this.view.head.sequence) - this.snapshotSequence >= 10n
      )
        this.saveSnapshot(this.view);
    } catch {}
    this.db.close();
  }
}

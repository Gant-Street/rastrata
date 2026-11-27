import { periodViews, fiscalYearViews } from "../calendar/periods.ts";
import { calendarCoverage } from "../calendar/kernel-calendar.ts";
import { ApplicationError } from "../errors.ts";
import type { ApplicationService, SourcedEntry } from "../service.ts";
import type { Committer } from "../slices/changes/store.ts";
import { booksBeganOn } from "../slices/shadow/cutover-date.ts";
import { ingestFor } from "../slices/statements/ports.ts";
import type { DateOrderChoice } from "../statements/dates.ts";
import { type ParsedHistory, parseHistory } from "./parse.ts";
import {
  planHistory,
  type ExistingJournal,
  type HistoryPlan,
  type NewAccount,
  type PlanBook,
  type PlannedEntry,
} from "./plan.ts";
import { NEW_ROLES, type NewRole } from "./roles.ts";
import { xeroStore } from "../slices/shadow/store.ts";
import type { BookState } from "@rastrata/kernel";

/** Bringing a business's past books in: preview what a journal file would do, then post it a chunk at a time.
 *
 * The file is uploaded once (`POST /v1/uploads`, addressed by its SHA-256) and every call refers to it, so a
 * history of tens of thousands of entries is never sent twice. The preview changes nothing. The import posts
 * the next chunk of what is not yet in the book and says how much is left; the same call, repeated until
 * nothing is left, is the whole import, and a call that is sent again changes nothing it did the first time,
 * because an entry's identity comes from the file and its number. */

/** How many entries one call posts when it is not told. A call is one request, and a request is one entry of
 * the log, which the tail that hosts books holds to 1 MiB once packed: posting an entry packs to about 22 KB
 * on a book with a calendar from 2000 (the book's first record is written again with every entry; see
 * docs/reference/program/history-import.md), so 20 is well inside it. A caller that is told `entry_too_large`
 * asks for fewer; one that is not may ask for more, up to `MAX_CHUNK`. */
export const DEFAULT_CHUNK = 20;
export const MAX_CHUNK = 500;

export interface HistoryInput {
  readonly file: string;
  readonly dateOrder?: DateOrderChoice;
  /** An account of the file the book names differently: the account as the file writes it, and either the
   * code of the book's account it is posted to or the kind of account to add to the book for it. */
  readonly map?: readonly {
    readonly account: string;
    readonly to?: string | undefined;
    readonly add?: NewRole | undefined;
  }[];
  readonly limit?: number;
}

export interface HistoryPreviewResult {
  readonly file: string;
  readonly entries: number;
  readonly lines: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  readonly dateOrder: "ymd" | "mdy" | "dmy" | null;
  readonly dateOrderAssumed: boolean;
  readonly years: HistoryPlan["years"];
  readonly accounts: HistoryPlan["accounts"];
  readonly unmapped: number;
  /** How many accounts the import adds to the book first. */
  readonly adding: number;
  readonly problems: HistoryPlan["problems"];
  readonly problemCount: number;
  readonly conflicts: readonly string[];
  readonly alreadyImported: number;
  readonly remaining: number;
  readonly ready: boolean;
  /** The day the books begin from, if the file starts before the day they begin now. */
  readonly startsBefore: string | null;
}

export interface HistoryProgress {
  /** Entries posted by this call. */
  readonly imported: number;
  /** Entries of this file now in the book. */
  readonly importedTotal: number;
  readonly remaining: number;
  readonly total: number;
  readonly done: boolean;
  /** The entry the book refused, which stops the call; everything before it is posted. */
  readonly failed: {
    readonly key: string;
    readonly date: string;
    readonly code: string;
    readonly message: string;
  } | null;
  /** The day the books begin from now, when this call moved it back. */
  readonly booksBegan: string | null;
}

const SOURCE_SYSTEM = "rastrata-source-v1";

/** What the book holds that a history must not meet, one small row for each journal. */
export function existingJournals(state: BookState): ExistingJournal[] {
  return state.journals.map((booked) => {
    let sourceId: string | null = null;
    for (const derivation of booked.derivations)
      for (const evidence of derivation.evidence)
        if (sourceId === null && evidence.sourceSystem === SOURCE_SYSTEM)
          sourceId = evidence.sourceRecordId;
    return { date: booked.journal.accountingDate as string, sourceId };
  });
}

/** What the move from Xero kept, for a file that writes Xero's codes: the mapping the owner saved (a Xero code left
 * out maps to nothing) and the kind of each Xero account by its type. Empty when no chart was imported. */
function xeroFacts(service: ApplicationService): NonNullable<PlanBook["xero"]> {
  const store = xeroStore(service);
  const mapping = new Map<string, string | null>();
  for (const [code, choice] of store.mapping())
    mapping.set(code.toLowerCase(), choice.skip ? null : choice.accountId);
  const roles = new Map<string, NewRole | null>();
  for (const account of store.accounts())
    roles.set(
      account.code.toLowerCase(),
      NEW_ROLES.includes(account.role as NewRole) ? (account.role as NewRole) : null,
    );
  return { mapping, roles };
}

/** The book as a plan reads it. */
export function planBook(service: ApplicationService, state: BookState): PlanBook {
  const views = periodViews(state, service.today(), null);
  return {
    xero: xeroFacts(service),
    accounts: state.admissionSnapshot.accounts
      .filter((account) => !account.closedOn)
      .map((account) => ({ id: account.id as string, code: account.code, name: account.name })),
    fiscalYears: fiscalYearViews(views).map((year) => ({
      fiscalYear: year.fiscalYear,
      startsOn: year.startsOn,
      endsOn: year.endsOn,
    })),
    existing: existingJournals(state),
    closed: views
      .filter((period) => period.status === "closed")
      .map((period) => ({ startsOn: period.startsOn, endsOn: period.endsOn })),
  };
}

const mapOf = (input: HistoryInput): Record<string, string> =>
  Object.fromEntries(
    (input.map ?? []).flatMap((pair) => (pair.to === undefined ? [] : [[pair.account, pair.to]])),
  );

const addsOf = (input: HistoryInput): Record<string, NewRole> =>
  Object.fromEntries(
    (input.map ?? []).flatMap((pair) => (pair.add === undefined ? [] : [[pair.account, pair.add]])),
  );

/** What reading a file gave, for the last few files of a book. An import is a call for every few entries of one
 * file, and the file is the same bytes every time (it is named by its SHA-256), so it is read once and not once a
 * call: for a file of thirty thousand entries that is the larger part of a call. What the file says is a function
 * of its bytes and of how its dates are read. It is kept for the service of one book and never shared: a process
 * can serve several books, and a file is a book's own (a hash is not a key to it). */
const READ_FILES = 2;
const reads = new WeakMap<ApplicationService, Map<string, ParsedHistory>>();

function parsedFile(service: ApplicationService, input: HistoryInput): ParsedHistory {
  let own = reads.get(service);
  if (!own) {
    own = new Map();
    reads.set(service, own);
  }
  const key = `${input.file}:${input.dateOrder ?? "auto"}`;
  const kept = own.get(key);
  if (kept) {
    own.delete(key);
    own.set(key, kept);
    return kept;
  }
  const archived = ingestFor(service).readArchive(input.file);
  if (!archived)
    throw new ApplicationError(
      "file_not_found",
      "That file has not been uploaded. Upload it first (POST /v1/uploads, or the command line), then name it by its SHA-256.",
      404,
    );
  const parsed = parseHistory(archived.bytes, input.dateOrder ?? "auto");
  own.set(key, parsed);
  for (const old of own.keys()) {
    if (own.size <= READ_FILES) break;
    own.delete(old);
  }
  return parsed;
}

/** Read the uploaded file and plan it against the book as it stands. */
async function plan(service: ApplicationService, input: HistoryInput) {
  const parsed = parsedFile(service, input);
  const { aggregate } = await service.readAggregate();
  const state = aggregate.state;
  const coverage = calendarCoverage(state.periods);
  const result = planHistory({
    parsed,
    book: planBook(service, state),
    sha256: input.file,
    mapping: mapOf(input),
    adds: addsOf(input),
    calendar: { firstDate: coverage.startsOn, lastDate: coverage.endsOn },
  });
  return { parsed, plan: result, calendarStart: coverage.startsOn };
}

export async function previewHistory(
  service: ApplicationService,
  input: HistoryInput,
): Promise<HistoryPreviewResult> {
  const { parsed, plan: result } = await plan(service, input);
  const began = booksBeganOn(service);
  return {
    file: input.file,
    entries: result.entryCount,
    lines: result.lines,
    firstDate: result.firstDate,
    lastDate: result.lastDate,
    dateOrder: parsed.dateOrder,
    dateOrderAssumed: parsed.dateOrderAssumed,
    years: result.years,
    accounts: result.accounts.slice(0, 1000),
    unmapped: result.unmapped,
    adding: result.newAccounts.length,
    problems: result.problems,
    problemCount: result.problemCount,
    conflicts: result.conflicts.slice(0, 20),
    alreadyImported: result.alreadyImported,
    remaining: Math.max(0, result.entryCount - result.alreadyImported),
    ready: result.ready,
    startsBefore:
      began !== null && result.firstDate !== null && result.firstDate < began
        ? result.firstDate
        : null,
  };
}

/** The reason an import cannot start, in one sentence a person can act on. */
function whyNot(result: HistoryPlan): string {
  const first = result.problems[0];
  if (result.entries.length === 0 && result.problemCount === 0 && result.conflicts.length === 0)
    return "The file holds no entries.";
  if (first)
    return `The file has ${result.problemCount} ${result.problemCount === 1 ? "problem" : "problems"}; the first, at row ${first.row}: ${first.message}`;
  if (result.unmapped > 0)
    return `${result.unmapped} ${result.unmapped === 1 ? "account is" : "accounts are"} not in the book. Say which of the book's accounts each is posted to, or add each as a new account.`;
  return result.conflicts[0] ?? "The file cannot be imported.";
}

export async function importHistory(
  service: ApplicationService,
  input: HistoryInput,
  committer: Committer,
): Promise<HistoryProgress> {
  let { plan: result, calendarStart } = await plan(service, input);
  if (!result.ready || result.firstDate === null)
    throw new ApplicationError("history_not_ready", whyNot(result), 409, [
      { path: "file", message: whyNot(result) },
    ]);
  // The accounts the file has and the book lacks are added first, in one change dated when the calendar begins
  // (or, for a later part of a history, on the part's first day), so that every entry of the file can be posted
  // to them. Once they are in the book the file's
  // accounts resolve to them by name or code, so a call that is sent again adds nothing twice.
  if (result.newAccounts.length > 0) {
    const effectiveOn = result.addAccountsOn ?? calendarStart;
    await service.createAccounts(
      {
        actionId: accountsActionId(input.file, result.newAccounts, effectiveOn),
        accounts: result.newAccounts.map(({ code, name, role }) => ({ code, name, role })),
        effectiveOn,
      },
      committer,
    );
    ({ plan: result, calendarStart } = await plan(service, input));
    if (!result.ready || result.firstDate === null || result.newAccounts.length > 0)
      throw new ApplicationError("history_not_ready", whyNot(result), 409, [
        { path: "file", message: whyNot(result) },
      ]);
  }
  // The books begin on the first day of the history.
  const before = booksBeganOn(service);
  if (before !== null && result.firstDate < before) service.moveBooksStartBack(result.firstDate);
  const have = new Set(
    (await service.readAggregate()).aggregate.state.journals.flatMap((booked) =>
      booked.derivations.flatMap((derivation) =>
        derivation.evidence.map((evidence) => evidence.sourceRecordId),
      ),
    ),
  );
  const todo = result.entries.filter((entry) => !have.has(entry.sourceId));
  const limit = Math.min(MAX_CHUNK, Math.max(1, input.limit ?? DEFAULT_CHUNK));
  const chunk = todo.slice(0, limit);
  const posted = await service.postSourced(chunk.map(sourced(input.file)), committer);
  if (posted.posted > 0) service.markHistoryImported();
  const total = result.entries.length;
  const importedTotal = total - todo.length + posted.posted;
  const failedEntry = posted.failed ? chunk[posted.failed.index] : undefined;
  return {
    imported: posted.posted,
    importedTotal,
    remaining: total - importedTotal,
    total,
    done: posted.failed === null && importedTotal === total,
    failed:
      posted.failed && failedEntry
        ? {
            key: failedEntry.key.slice(0, 60),
            date: failedEntry.date,
            code: posted.failed.code.slice(0, 80),
            message: posted.failed.message.slice(0, 600),
          }
        : null,
    booksBegan: booksBeganOn(service),
  };
}

/** The identity of the change that adds a file's accounts: from the file and the accounts, in the form of an
 * action identity, so that the same request is the same change and another request is another. */
function accountsActionId(
  sha256: string,
  accounts: readonly NewAccount[],
  effectiveOn: string,
): string {
  const hex = new Bun.CryptoHasher("sha256")
    .update(
      `${sha256}|${effectiveOn}|${accounts.map((a) => `${a.code}:${a.role}:${a.name}`).join("|")}`,
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const sourced =
  (sha256: string) =>
  (entry: PlannedEntry): SourcedEntry => ({
    date: entry.date,
    reference: entry.reference,
    narration: entry.narration,
    source: {
      id: entry.sourceId,
      description: `History import, entry ${entry.key}`,
      evidenceReference: `file ${sha256.slice(0, 12)}`,
    },
    lines: entry.lines,
  });

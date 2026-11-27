import type { BookState } from "@rastrata/kernel";

import type {
  AccountActivity,
  BalanceKind,
  GeneralLedger,
  GeneralLedgerAccount,
  GeneralLedgerLine,
  ReportBasis,
} from "../client-contracts.gen.ts";
import { ApplicationError } from "../errors.ts";
import { formatMoney } from "../money.ts";
import { calendarNotConfigured, type FiscalCalendar } from "./calendar.ts";
import { compareAccounts, isProfitLossRole, type ChartAccount } from "./chart.ts";
import { reportContext, requireDate, resolveRange, type ReportContext } from "./columns.ts";
import { postingCents } from "./ledger.ts";
import { runOf, type Run, type RunningRow } from "./ledger-lines.ts";
import { COMPILER_VERSION, populationHash } from "./population.ts";

const money = formatMoney;

/** One posting of one account, in ledger order. */
interface AccountPosting {
  readonly journalId: string;
  readonly postingId: string;
  readonly date: string;
  readonly narration: string;
  /** The entry's number in the book (its posting sequence). */
  readonly sequence: string;
  readonly cents: bigint;
}

/** How many postings this process has looked at one by one to read an account, which a read of the lines of an
 * account by day does not: a test or a bench reads it before and after a look to say that the look was not a pass
 * over the book. It carries no accounting meaning. */
const walked = { postings: 0 };
export const postingsWalked = (): number => walked.postings;

/** The journals a report as of `to` reads, in ledger order, as the postings of the accounts wanted
 * (every account when `only` is omitted). A journal's own postings keep their ordinal order. */
function collectPostings(
  context: ReportContext,
  to: string,
  only?: ReadonlySet<string>,
): Map<string, AccountPosting[]> {
  const byAccount = new Map<string, AccountPosting[]>();
  for (const booked of context.view.included(to).journals) {
    const postings =
      booked.journal.postings.length > 1
        ? [...booked.journal.postings].sort((left, right) => Number(left.ordinal - right.ordinal))
        : booked.journal.postings;
    for (const posting of postings) {
      walked.postings += 1;
      const account = posting.accountId as string;
      if (only && !only.has(account)) continue;
      let list = byAccount.get(account);
      if (!list) {
        list = [];
        byAccount.set(account, list);
      }
      list.push({
        journalId: booked.journal.id,
        postingId: posting.id,
        date: booked.journal.accountingDate,
        narration: booked.journal.narration,
        sequence: booked.postingSequence.toString(),
        cents: postingCents(posting),
      });
    }
  }
  return byAccount;
}

interface RunningLine extends AccountPosting {
  readonly running: bigint;
}

/** One account's balances and lines over a range. Balance-sheet accounts carry their balance forward
 * from the beginning of the book. Income and expense accounts start each fiscal year from zero,
 * because the earnings of earlier years are rolled into equity by computation: the opening balance
 * is the fiscal year to date before the range, and the running balance resets where a new fiscal year
 * begins. This is what makes an amount on a statement equal the activity behind it. */
interface AccountRun {
  readonly kind: BalanceKind;
  readonly opening: bigint;
  readonly closing: bigint;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly net: bigint;
  readonly lines: readonly RunningLine[];
}

function runAccount(
  role: ChartAccount["role"],
  postings: readonly AccountPosting[],
  from: string,
  to: string,
  calendar: FiscalCalendar,
): AccountRun {
  const profitLoss = isProfitLossRole(role);
  const yearStart = (date: string) => calendar.yearOf(date)?.startsOn ?? "";
  const openingFloor = profitLoss ? yearStart(from) : "";
  const closingFloor = profitLoss ? yearStart(to) : "";
  let opening = 0n;
  let closing = 0n;
  let debit = 0n;
  let credit = 0n;
  let net = 0n;
  const lines: RunningLine[] = [];
  let running = 0n;
  let runningYear = openingFloor;
  for (const posting of postings) {
    if (posting.date > to) break;
    if (posting.date >= closingFloor) closing += posting.cents;
    if (posting.date < from) {
      if (posting.date >= openingFloor) opening += posting.cents;
      continue;
    }
    if (lines.length === 0) running = opening;
    if (profitLoss) {
      const year = yearStart(posting.date);
      if (year !== runningYear) {
        running = 0n;
        runningYear = year;
      }
    }
    running += posting.cents;
    net += posting.cents;
    if (posting.cents > 0n) debit += posting.cents;
    else credit -= posting.cents;
    lines.push({ ...posting, running });
  }
  return {
    kind: profitLoss ? "fiscalYearToDate" : "cumulative",
    opening,
    closing,
    debit,
    credit,
    net,
    lines,
  };
}

/** An account's lines in a range as the screens and the files say them. */
type LedgerLine = RunningLine;

const lineOf = (row: RunningRow): LedgerLine => ({
  journalId: row.booked.journal.id,
  postingId: row.posting.id,
  date: row.booked.journal.accountingDate,
  narration: row.booked.journal.narration,
  sequence: row.booked.postingSequence.toString(),
  cents: postingCents(row.posting),
  running: row.running,
});

/** What one account came to over a range, and a page of its lines. */
interface AccountRead {
  readonly kind: BalanceKind;
  readonly opening: bigint;
  readonly closing: bigint;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly net: bigint;
  readonly lineCount: number;
  lines(offset: number, limit: number): LedgerLine[];
}

/** One account over a range, read from the lines of its days that the book's view keeps (see `AccountDays`),
 * which costs the lines of the page and the days the range crosses, and not every posting of the account; or,
 * for a book with a journal a correction supersedes, which takes the journal out of a report from the day the
 * correction is dated, or when `byPostings` asks for it (the reference the lines are held to), from every posting
 * of the book up to the end of the range, one after the other. */
function readAccount(
  context: ReportContext,
  account: ChartAccount,
  from: string,
  to: string,
  byPostings = false,
): AccountRead {
  const profitLoss = isProfitLossRole(account.role);
  if (byPostings || context.view.hasSupersessions) {
    const postings = collectPostings(context, to, new Set([account.id])).get(account.id) ?? [];
    const run = runAccount(account.role, postings, from, to, context.calendar);
    return {
      ...run,
      lineCount: run.lines.length,
      lines: (offset, limit) => run.lines.slice(offset, offset + limit),
    };
  }
  const run: Run = runOf(
    context.view.accountLines().account(account.id),
    profitLoss,
    from,
    to,
    (date) => context.calendar.yearOf(date)?.startsOn ?? "",
  );
  return {
    kind: profitLoss ? "fiscalYearToDate" : "cumulative",
    opening: run.opening,
    closing: run.closing,
    debit: run.debit,
    credit: run.credit,
    net: run.net,
    lineCount: run.lineCount,
    lines: (offset, limit) => run.lines(offset, limit).map(lineOf),
  };
}

const debitOf = (cents: bigint) => (cents > 0n ? money(cents) : "0.00");
const creditOf = (cents: bigint) => (cents < 0n ? money(-cents) : "0.00");

/** Confirm a population hash identifies the report the caller was shown, rebuilding it from the
 * report's own inputs: the as-of date, the revision the state was read at, and the range start the
 * report used (the start of the fiscal year when none was given). A hash from a report of another
 * range, basis or book state does not match. */
export function verifyPopulation(
  state: BookState,
  scope: { readonly asOf: string; readonly reportFrom?: string; readonly populationHash: string },
): { readonly context: ReportContext; readonly range: ReturnType<typeof resolveRange> } {
  const { context, range, hash } = readPopulation(state, scope);
  if (hash !== scope.populationHash) throw populationChanged();
  return { context, range };
}

/** The population of a report as of a date: its context, its range, and the fingerprint of what it reads. A
 * caller that has no report to name reads this, and passes the fingerprint on to pin the pages after the first. */
function readPopulation(
  state: BookState,
  scope: { readonly asOf: string; readonly reportFrom?: string },
): {
  readonly context: ReportContext;
  readonly range: ReturnType<typeof resolveRange>;
  readonly hash: string;
} {
  const context = reportContext(state, scope.asOf);
  const range = resolveRange(context, scope.asOf, scope.reportFrom);
  const hash = populationHash(state, context.chart, {
    asOf: scope.asOf,
    from: range.from,
    basis: context.basis,
    fiscalYear: range.fiscalYear,
  });
  return { context, range, hash };
}

const populationChanged = (): ApplicationError =>
  new ApplicationError(
    "report_population_changed",
    "Report population has changed. The book changed or the report's range or basis differs; read the report again.",
    409,
  );

export const ACTIVITY_PAGE_SIZE = 25;

export interface ActivityQuery {
  readonly accountId: string;
  readonly asOf: string;
  readonly from: string;
  readonly to: string;
  readonly reportFrom?: string;
  /** The fingerprint of the report the lines must belong to. Left out, the lines are read as the book stands
   * and the reply names the population, so the next page can be pinned to it. */
  readonly populationHash?: string;
  readonly page: number;
}

/** One account's lines in a range with running balances, under a report's population. */
export function accountActivity(state: BookState, query: ActivityQuery): AccountActivity {
  return activityOf(state, query, false);
}

/** The same as `accountActivity`, made by reading every posting of the book up to the end of the range, which is
 * what it was before the lines of each account were kept by day: the reference those are held to. */
export function accountActivityByPostings(state: BookState, query: ActivityQuery): AccountActivity {
  return activityOf(state, query, true);
}

function activityOf(state: BookState, query: ActivityQuery, byPostings: boolean): AccountActivity {
  if (!Number.isSafeInteger(query.page) || query.page < 1 || query.page > 100000)
    throw new ApplicationError("invalid_input", "Invalid account activity page", 400);
  requireDate(query.from, "from");
  requireDate(query.to, "to");
  if (query.from > query.to || query.to > query.asOf)
    throw new ApplicationError(
      "invalid_input",
      "Account activity needs from on or before to, and to on or before asOf",
      400,
      [{ path: "from", message: `${query.from}..${query.to} within ${query.asOf}` }],
    );
  const read = readPopulation(state, query);
  if (query.populationHash !== undefined && query.populationHash !== read.hash)
    throw populationChanged();
  const { context, range } = read;
  const account = context.accounts.find((item) => item.id === query.accountId);
  if (!account)
    throw new ApplicationError(
      "account_not_in_report",
      "Account is not in this report's chart snapshot",
      404,
    );
  if (query.from < context.calendar.firstDate)
    throw calendarNotConfigured(context.calendar, query.from, "from");
  const run = readAccount(context, account, query.from, query.to, byPostings);
  const normalSide = context.chart.admissionSnapshot.accounts.find(
    (item) => item.id === account.id,
  )?.normalSide;
  return {
    account: {
      id: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      normalSide:
        normalSide ?? (account.role === "asset" || account.role === "expense" ? "debit" : "credit"),
    },
    currency: state.identity.functionalCommodityId,
    basis: context.basis,
    asOf: query.asOf,
    from: query.from,
    to: query.to,
    reportFrom: range.from,
    revision: state.bookRevision.toString(),
    populationHash: read.hash,
    balanceKind: run.kind,
    openingBalance: money(run.opening),
    closingBalance: money(run.closing),
    totalDebit: money(run.debit),
    totalCredit: money(run.credit),
    netChange: money(run.net),
    count: run.lineCount,
    page: query.page,
    pageSize: ACTIVITY_PAGE_SIZE,
    rows: run.lines((query.page - 1) * ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE).map((line) => ({
      journalId: line.journalId,
      postingId: line.postingId,
      date: line.date,
      narration: line.narration,
      postingSequence: line.sequence,
      debit: debitOf(line.cents),
      credit: creditOf(line.cents),
      runningBalance: money(line.running),
    })),
  };
}

export const GENERAL_LEDGER_PAGE_SIZE = 100;

/** An account's line of the general ledger's list of accounts. */
function summaryOf(account: ChartAccount, read: AccountRead): GeneralLedgerAccount {
  return {
    accountId: account.id,
    code: account.code,
    name: account.name,
    role: account.role,
    balanceKind: read.kind,
    openingBalance: money(read.opening),
    totalDebit: money(read.debit),
    totalCredit: money(read.credit),
    netChange: money(read.net),
    closingBalance: money(read.closing),
    lineCount: read.lineCount,
  };
}

/** A line of the general ledger. */
function ledgerLine(accountId: string, line: LedgerLine): GeneralLedgerLine {
  return {
    accountId,
    journalId: line.journalId,
    postingId: line.postingId,
    date: line.date,
    narration: line.narration,
    postingSequence: line.sequence,
    debit: debitOf(line.cents),
    credit: creditOf(line.cents),
    runningBalance: money(line.running),
  };
}

export interface GeneralLedgerQuery {
  readonly asOf: string;
  readonly from?: string;
  readonly page: number;
  readonly basis?: ReportBasis;
}

/** Every account's postings in a range, in account order, with opening, running and closing
 * balances: the general ledger, whole. A page of it is `compileGeneralLedger`; an export reads all. */
export function generalLedgerData(
  state: BookState,
  query: Omit<GeneralLedgerQuery, "page">,
): Omit<GeneralLedger, "page" | "pageSize" | "count" | "lines"> & {
  readonly lines: readonly GeneralLedgerLine[];
} {
  const context = reportContext(state, query.asOf, query.basis);
  const range = resolveRange(context, query.asOf, query.from);
  const postings = collectPostings(context, query.asOf);
  const accounts: GeneralLedgerAccount[] = [];
  const lines: GeneralLedgerLine[] = [];
  for (const account of [...context.accounts].sort(compareAccounts)) {
    const run = runAccount(
      account.role,
      postings.get(account.id) ?? [],
      range.from,
      query.asOf,
      context.calendar,
    );
    if (run.lines.length === 0 && run.opening === 0n && run.closing === 0n) continue;
    accounts.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      balanceKind: run.kind,
      openingBalance: money(run.opening),
      totalDebit: money(run.debit),
      totalCredit: money(run.credit),
      netChange: money(run.net),
      closingBalance: money(run.closing),
      lineCount: run.lines.length,
    });
    for (const line of run.lines)
      lines.push({
        accountId: account.id,
        journalId: line.journalId,
        postingId: line.postingId,
        date: line.date,
        narration: line.narration,
        postingSequence: line.sequence,
        debit: debitOf(line.cents),
        credit: creditOf(line.cents),
        runningBalance: money(line.running),
      });
  }
  return {
    compilerVersion: COMPILER_VERSION,
    populationHash: populationHash(state, context.chart, {
      asOf: query.asOf,
      from: range.from,
      basis: context.basis,
      fiscalYear: range.fiscalYear,
    }),
    bookRevision: state.bookRevision.toString(),
    postingSequence: state.latestPostingSequence.toString(),
    asOf: query.asOf,
    periodStart: range.from,
    currency: state.identity.functionalCommodityId,
    basis: context.basis,
    fiscalYear: range.fiscalYear,
    accounts,
    lines,
  };
}

/** One page of the general ledger. It is read from the same population as the statements for the
 * range, so its hash is the one `reports.get` returns for those inputs. Every account's figures for the range are
 * read from the lines of its days, and the lines of the page from the first account that has some on, so a page
 * costs the accounts of the book and the days it crosses and not its postings (a book that has a journal a
 * correction supersedes is read by its postings, as `compileGeneralLedgerByPostings` reads every book). */
export function compileGeneralLedger(state: BookState, query: GeneralLedgerQuery): GeneralLedger {
  if (!Number.isSafeInteger(query.page) || query.page < 1 || query.page > 100000)
    throw new ApplicationError("invalid_input", "Invalid general ledger page", 400);
  const context = reportContext(state, query.asOf, query.basis);
  if (context.view.hasSupersessions) return compileGeneralLedgerByPostings(state, query);
  const range = resolveRange(context, query.asOf, query.from);
  const reads: { account: ChartAccount; read: AccountRead }[] = [];
  const accounts: GeneralLedgerAccount[] = [];
  let count = 0;
  for (const account of [...context.accounts].sort(compareAccounts)) {
    const read = readAccount(context, account, range.from, query.asOf);
    if (read.lineCount === 0 && read.opening === 0n && read.closing === 0n) continue;
    reads.push({ account, read });
    accounts.push(summaryOf(account, read));
    count += read.lineCount;
  }
  // The page is the lines from `offset` on, whichever accounts they are of.
  let skip = (query.page - 1) * GENERAL_LEDGER_PAGE_SIZE;
  const lines: GeneralLedgerLine[] = [];
  for (const { account, read } of reads) {
    if (lines.length >= GENERAL_LEDGER_PAGE_SIZE) break;
    if (skip >= read.lineCount) {
      skip -= read.lineCount;
      continue;
    }
    for (const line of read.lines(skip, GENERAL_LEDGER_PAGE_SIZE - lines.length))
      lines.push(ledgerLine(account.id, line));
    skip = 0;
  }
  return {
    compilerVersion: COMPILER_VERSION,
    populationHash: populationHash(state, context.chart, {
      asOf: query.asOf,
      from: range.from,
      basis: context.basis,
      fiscalYear: range.fiscalYear,
    }),
    bookRevision: state.bookRevision.toString(),
    postingSequence: state.latestPostingSequence.toString(),
    asOf: query.asOf,
    periodStart: range.from,
    currency: state.identity.functionalCommodityId,
    basis: context.basis,
    fiscalYear: range.fiscalYear,
    accounts,
    count,
    page: query.page,
    pageSize: GENERAL_LEDGER_PAGE_SIZE,
    lines,
  };
}

/** The same as `compileGeneralLedger`, made by reading every posting of the book, which is what it was before the
 * lines of each account were kept by day: the reference those are held to, and how a book with a superseded
 * journal is read. */
export function compileGeneralLedgerByPostings(
  state: BookState,
  query: GeneralLedgerQuery,
): GeneralLedger {
  if (!Number.isSafeInteger(query.page) || query.page < 1 || query.page > 100000)
    throw new ApplicationError("invalid_input", "Invalid general ledger page", 400);
  const { lines, ...ledger } = generalLedgerData(state, query);
  return {
    ...ledger,
    count: lines.length,
    page: query.page,
    pageSize: GENERAL_LEDGER_PAGE_SIZE,
    lines: lines.slice(
      (query.page - 1) * GENERAL_LEDGER_PAGE_SIZE,
      query.page * GENERAL_LEDGER_PAGE_SIZE,
    ),
  };
}

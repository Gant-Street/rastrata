/** Opening balances as an operation: review them, plan the one entry, and say where the opening
 * entry stands. The entry is an ordinary balanced journal posted through the same draft, prepare and
 * commit path as any other, so it is reviewed, hash-checked and carries a source identity the ledger
 * refuses to post twice. Nothing here posts: `opening.plan` ends at a prepared plan, and
 * `operations.commit` is what changes the books. */
import { describePrincipal } from "../../agent/principal.ts";
import type {
  OpeningCalendar,
  OpeningExisting,
  OpeningInput,
  OpeningIssue as WireIssue,
  OpeningPlan,
  OpeningReview,
  PeriodList,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { deriveUuid, sha256Hex, stableStringify } from "../../ingest/hash.ts";
import { addDays } from "../../reports/dates.ts";
import type { ApplicationService } from "../../service.ts";
import {
  buildOpening,
  isCalendarDate,
  isOpeningBalanceAccount,
  type OpeningEntry,
  type OpeningIssue,
} from "../../shadow/opening.ts";
import { parseOpeningCsv } from "../../shadow/opening-csv.ts";
import type { SliceContext } from "../types.ts";
import { type Chart, readChart, readPeriods } from "./chart.ts";
import { shadowStore } from "./store.ts";

const RANK = { error: 0, warning: 1, info: 2 } as const;
const MAX_ISSUES = 400;

const error = (code: string, message: string): OpeningIssue => ({
  severity: "error",
  code,
  message,
});

/** The source identity of an opening entry: content addressed, so the same balances always mean
 * the same source and the ledger refuses to post them twice. */
export const openingSourceId = (cutoverDate: string, contentHash: string): string =>
  `opening-${cutoverDate}-${contentHash.slice(0, 12)}`;

/** What is known of the opening entry the opening tools made: nothing, planned and waiting to be
 * posted, posted, or posted and since reversed. Read from the ledger's own record of each source,
 * never from a flag. The date of the entry is the date of its draft, which is what was posted. */
export async function openingStatus(
  service: ApplicationService,
): Promise<{ readonly existing: OpeningExisting; readonly ownJournalIds: ReadonlySet<string> }> {
  const own = new Set<string>();
  let planned: OpeningExisting | null = null;
  let reversed: OpeningExisting | null = null;
  let posted: OpeningExisting | null = null;
  for (const row of [...shadowStore(service).openings()].reverse()) {
    let source: Awaited<ReturnType<ApplicationService["source"]>>;
    try {
      source = await service.source(row.sourceId);
    } catch (cause) {
      // The plan was recorded and the draft never reached the book: nothing to report.
      if (cause instanceof ApplicationError && cause.code === "source_not_found") continue;
      throw cause;
    }
    const known = {
      sourceId: row.sourceId,
      planId: row.planId,
      cutoverDate: row.cutoverOn,
      entryDate: (row.draftId ? service.draft(row.draftId)?.data.date : undefined) ?? row.cutoverOn,
      by: row.principal,
    };
    if (source.status === "posted") {
      own.add(source.journalId);
      for (const correction of source.corrections) own.add(correction.correctionJournalId);
      if (source.corrections.length === 0)
        posted ??= { status: "posted", journalId: source.journalId, ...known };
      else reversed ??= { status: "reversed", journalId: source.journalId, ...known };
    } else if (!row.superseded) planned ??= { status: "planned", ...known };
  }
  return { existing: posted ?? planned ?? reversed ?? { status: "none" }, ownJournalIds: own };
}

/** An opening entry made by hand: the way the tutorial says to enter opening balances, one ordinary
 * journal against the equity account named for opening balances, dated before the cutover. */
export interface HandMadeOpening {
  readonly journalId: string;
  readonly date: string;
  readonly account: { readonly id: string; readonly code: string; readonly name: string };
}

/** The earliest posted journal dated before the cutover that has a line on the equity account named
 * for opening balances and is not the opening tools' own entry, or null. A journal that was reversed
 * or corrected does not count (the balances it carried are gone), nor does the reversal. Without a
 * cutover date there is no "before", so nothing is found. */
export async function findHandMadeOpening(
  service: ApplicationService,
  chart: Chart,
  cutoverDate: string | null,
  ownJournalIds: ReadonlySet<string>,
): Promise<HandMadeOpening | null> {
  if (cutoverDate === null || !isCalendarDate(cutoverDate)) return null;
  const offsets = new Map(
    chart.accounts.filter(isOpeningBalanceAccount).map((account) => [account.id, account]),
  );
  if (offsets.size === 0) return null;
  const { aggregate } = await service.readAggregate();
  const { journals, corrections } = aggregate.state;
  const corrected = new Set<string>();
  for (const link of corrections) {
    corrected.add(link.originalJournalId as string);
    corrected.add(link.correctionJournalId as string);
  }
  let found: HandMadeOpening | null = null;
  for (const booked of journals) {
    const { accountingDate: date, postings } = booked.journal;
    const id = booked.journal.id as string;
    if (date >= cutoverDate || ownJournalIds.has(id) || corrected.has(id)) continue;
    if (found !== null && found.date <= date) continue;
    for (const posting of postings) {
      const account = offsets.get(posting.accountId as string);
      if (!account) continue;
      found = {
        journalId: id,
        date,
        account: { id: account.id, code: account.code, name: account.name },
      };
      break;
    }
  }
  return found;
}

/** The hand-made entry as the opening entry the book has. */
export const handMadeExisting = (found: HandMadeOpening): OpeningExisting => ({
  status: "posted",
  journalId: found.journalId,
  entryDate: found.date,
  byHand: true,
});

/** The date the opening entry is posted on. Opening balances are the balances at the start of the
 * cutover date, so the entry is dated the day before: the books then start from them, and the first
 * day's own activity is all that the reports of the cutover month show. When the cutover is the first
 * day of the book's calendar there is no day before, and a closed period cannot take an entry, so the
 * entry is dated on the cutover date itself. */
export function entryDateFor(list: PeriodList, cutoverDate: string): string {
  if (!isCalendarDate(cutoverDate)) return cutoverDate;
  const before = addDays(cutoverDate, -1);
  if (before < list.calendar.firstDate) return cutoverDate;
  const period = list.periods.find((item) => item.startsOn <= before && before <= item.endsOn);
  return period?.status === "open" ? before : cutoverDate;
}

const periodOn = (list: PeriodList, day: string) =>
  list.periods.find((item) => item.startsOn <= day && day <= item.endsOn);

/** What the calendar says about a cutover date, and the date the entry for it is posted on. */
function calendarFacts(
  list: PeriodList,
  cutoverDate: string,
): {
  readonly calendar: OpeningCalendar | null;
  readonly issues: OpeningIssue[];
  readonly entryDate: string | null;
} {
  const issues: OpeningIssue[] = [];
  if (!isCalendarDate(cutoverDate)) return { calendar: null, issues, entryDate: null };
  const { firstDate, lastDate } = list.calendar;
  if (cutoverDate < firstDate) {
    issues.push(
      error(
        "date_before_book",
        `The book's first day is ${firstDate}, and it cannot move earlier. Choose a cutover date on or after it, or create the book with an earlier first fiscal year.`,
      ),
    );
    return { calendar: null, issues, entryDate: null };
  }
  if (cutoverDate > lastDate) {
    issues.push(
      error(
        "date_after_calendar",
        `The book's calendar ends on ${lastDate}. Record ${cutoverDate} as the start date first (cutover.set): the calendar grows to cover it.`,
      ),
    );
    return { calendar: null, issues, entryDate: null };
  }
  const period = periodOn(list, cutoverDate);
  if (!period) return { calendar: null, issues, entryDate: null };
  const entryDate = entryDateFor(list, cutoverDate);
  const entryPeriod = periodOn(list, entryDate);
  if (entryPeriod?.status === "closed")
    issues.push(
      error(
        "period_closed",
        `${entryPeriod.label} (${entryPeriod.startsOn} to ${entryPeriod.endsOn}) is closed. Reopen it before posting opening balances into it.`,
      ),
    );
  return {
    entryDate,
    calendar: {
      firstDate,
      lastDate,
      periodId: period.id,
      periodLabel: period.label,
      periodStatus: period.status,
      periodStart: period.startsOn === cutoverDate,
      fiscalYearStart: list.calendar.fiscalYears.some((year) => year.startsOn === cutoverDate),
    },
    issues,
  };
}

/** Check opening balances against the chart, the calendar, the recorded cutover and what has already
 * been posted. Changes nothing. */
export async function reviewOpening(
  context: SliceContext,
  input: OpeningInput,
): Promise<OpeningReview> {
  const { service } = context;
  if (input.balances !== undefined && input.csv !== undefined)
    throw new ApplicationError("invalid_input", "Give balances or csv, not both.", 400, [
      { path: "input.csv", message: "Give balances or csv, not both" },
    ]);
  const [chart, periods] = await Promise.all([readChart(context), readPeriods(context)]);
  const issues: OpeningIssue[] = [];
  let entries: OpeningEntry[];
  if (input.csv !== undefined) {
    const parsed = parseOpeningCsv(input.csv, chart.accounts);
    entries = [...parsed.entries];
    issues.push(...parsed.issues);
  } else
    entries = (input.balances ?? []).map((item) => ({
      accountId: item.accountId,
      balance: item.balance,
    }));

  const date = input.cutoverDate;
  const { calendar, issues: calendarIssues, entryDate: preferred } = calendarFacts(periods, date);
  issues.push(...calendarIssues);
  const build = (entryDate: string | null) =>
    buildOpening({
      cutoverDate: date,
      ...(entryDate !== null ? { entryDate } : {}),
      accounts: chart.accounts,
      entries,
      ...(input.offsetAccountId !== undefined ? { offsetAccountId: input.offsetAccountId } : {}),
      ...(calendar ? { calendar: { fiscalYearStart: calendar.fiscalYearStart } } : {}),
    });
  let entryDate = preferred;
  let built = build(entryDate);
  // An account that opens on the cutover date itself cannot take an entry dated the day before: the
  // entry is then dated on the cutover date, when that day can take it.
  if (
    entryDate !== null &&
    entryDate !== date &&
    built.issues.some((issue) => issue.code === "account_not_open") &&
    periodOn(periods, date)?.status === "open"
  ) {
    const onCutover = build(date);
    if (!onCutover.issues.some((issue) => issue.code === "account_not_open")) {
      built = onCutover;
      entryDate = date;
      issues.push({
        severity: "info",
        code: "entry_on_cutover_date",
        message: `The opening entry is dated ${date}, the cutover date itself, because an account in it opens on that day.`,
      });
    }
  }
  issues.push(...built.issues);

  const recorded = shadowStore(service).cutover();
  if (!recorded)
    issues.push(
      error(
        "cutover_not_set",
        `The cutover date has not been recorded. Record ${date} first (rastrata cutover set --date ${date}): the opening entry and the Inbox's start dates must be the same day.`,
      ),
    );
  else if (recorded.cutoverOn !== date)
    issues.push(
      error(
        "cutover_differs",
        `The recorded cutover date is ${recorded.cutoverOn}, but these balances are dated ${date}. They must be the same day: use ${recorded.cutoverOn}, or record ${date} as the cutover date first.`,
      ),
    );

  const tool = await openingStatus(service);
  const { ownJournalIds } = tool;
  const handMade =
    tool.existing.status === "posted"
      ? null
      : await findHandMadeOpening(service, chart, date, ownJournalIds);
  const existing = handMade ? handMadeExisting(handMade) : tool.existing;
  if (tool.existing.status === "posted")
    issues.push(
      error(
        "opening_exists",
        `Opening balances were already posted (dated ${tool.existing.entryDate ?? tool.existing.cutoverDate}). To change them, reverse that entry, then plan again.`,
      ),
    );
  else if (handMade)
    issues.push({
      severity: "error",
      code: "opening_by_hand",
      message: `The opening balances were already entered by hand: the entry dated ${handMade.date} has a line on ${handMade.account.code} ${handMade.account.name}. Planning another would count them twice. To use the opening tools instead, reverse that entry first.`,
      accountId: handMade.account.id,
    });
  else if (tool.existing.status === "planned")
    issues.push({
      severity: "info",
      code: "opening_replaced",
      message: "An opening entry is already planned and not posted. Planning again replaces it.",
    });

  if (isCalendarDate(date)) {
    const { aggregate } = await service.readAggregate();
    const before = aggregate.state.journals.filter(
      (item) =>
        item.journal.accountingDate < date &&
        !ownJournalIds.has(item.journal.id) &&
        item.journal.id !== handMade?.journalId,
    ).length;
    if (before > 0)
      issues.push({
        severity: "warning",
        code: "journals_before_cutover",
        message: `The book already has ${before} ${before === 1 ? "entry" : "entries"} dated before ${date}. Opening balances are the balances at the start of ${date}, so those entries would be counted twice.`,
      });
  }

  issues.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const valid = !issues.some((issue) => issue.severity === "error");
  const contentHash = valid
    ? sha256Hex(
        stableStringify({
          version: 2,
          cutoverDate: date,
          entryDate: entryDate ?? date,
          journal: built.journal,
        }),
      )
    : null;
  return {
    cutoverDate: date,
    entryDate,
    currency: chart.currency,
    valid,
    lines: built.lines.map((line) => ({ ...line })),
    offset: built.offset ? { ...built.offset } : null,
    totals: { ...built.totals },
    zeroBalances: built.zeroBalances,
    issues: issues.slice(0, MAX_ISSUES).map((issue): WireIssue => ({ ...issue })),
    contentHash,
    sourceId: contentHash ? openingSourceId(date, contentHash) : null,
    calendar,
    recordedCutover: recorded?.cutoverOn ?? null,
    existing,
  };
}

/** Turn reviewed balances into the one draft and its prepared plan. Retried under the same
 * identity it returns the plan it made; the draft is found again, never made twice. */
export async function planOpening(
  context: SliceContext,
  input: OpeningInput,
  operationId: string,
): Promise<OpeningPlan> {
  const { service } = context;
  return service.retainAsyncRequest(operationId, "opening.plan", input, async () => {
    const review = await reviewOpening(context, input);
    if (
      !review.valid ||
      review.contentHash === null ||
      review.sourceId === null ||
      review.entryDate === null
    ) {
      const errors = review.issues.filter((issue) => issue.severity === "error");
      throw new ApplicationError(
        "opening_invalid",
        `The opening balances cannot be planned: ${errors[0]?.message ?? "review them first."}`,
        422,
        errors.slice(0, 20).map((issue) => ({
          path:
            issue.row !== undefined ? `input.csv row ${issue.row}` : (issue.accountId ?? "input"),
          message: issue.message,
        })),
      );
    }
    const store = shadowStore(service);
    const planId = deriveUuid(["shadow.opening.plan", operationId]);
    store.addOpening({
      requestId: operationId,
      sourceId: review.sourceId,
      planId,
      cutoverOn: review.cutoverDate,
      contentHash: review.contentHash,
      principal: describePrincipal(context.access.principal),
      createdAt: context.service.now(),
    });
    // Planning again replaces what was planned and not posted: its draft is discarded so the Journal
    // does not collect abandoned drafts.
    for (const earlier of store.openings()) {
      if (earlier.requestId === operationId || earlier.superseded) continue;
      store.supersede(earlier.requestId);
      const draft = earlier.draftId ? service.draft(earlier.draftId) : null;
      if (draft?.status === "draft")
        try {
          service.discardDraft(draft.id, draft.version);
        } catch {
          // Someone changed it first; it is no longer ours to discard.
        }
    }
    const mine = store.openingByRequest(operationId);
    let draft = mine?.draftId ? service.draft(mine.draftId) : null;
    if (!draft) {
      draft = service.createDraft({
        date: review.entryDate,
        reference: "OPENING",
        // No date in the words: a list of transactions shows the entry's date in its own column, and a
        // date written into the text would be read as it was typed (year, month, day) whatever format the
        // owner chose for dates.
        narration: "Opening balances",
        source: {
          id: review.sourceId,
          description: "Opening balances, entered through Rastrata's cutover tools.",
          evidenceReference: `shadow:opening:v1:sha256=${review.contentHash}`,
        },
        lines: openingJournal(review),
      });
      store.setDraft(operationId, draft.id);
    }
    const plan = (await service.prepareDraft(
      draft.id,
      draft.version,
      planId,
    )) as OpeningPlan["plan"];
    return { review, draft: { id: draft.id, version: draft.version }, plan };
  });
}

/** The journal lines of a valid review: accounts in code order, the offset last. */
function openingJournal(
  review: OpeningReview,
): { accountId: string; debit: string; credit: string }[] {
  const side = (amount: string) => (amount === "0.00" ? "" : amount);
  return [
    ...review.lines.map((line) => ({
      accountId: line.accountId,
      debit: side(line.debit),
      credit: side(line.credit),
    })),
    ...(review.offset
      ? [
          {
            accountId: review.offset.accountId,
            debit: side(review.offset.debit),
            credit: side(review.offset.credit),
          },
        ]
      : []),
  ];
}

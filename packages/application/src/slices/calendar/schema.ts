import {
  array,
  date,
  hash,
  id,
  nullable,
  object,
  operation,
  ref,
  revision,
  signedMoney,
  text,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

/** The range `book.setup` accepts for a fiscal year; the calendar never runs past it. */
const fiscalYear: Schema = { type: "integer", minimum: 2000, maximum: 2100 };
const count: Schema = { type: "integer", minimum: 0 };
const periodModel: Schema = { type: "string", enum: ["monthly", "quarterly"] };
const reason = (maxLength: number): Schema => ({
  ...text(maxLength),
  minLength: 1,
  pattern: "\\S",
});

export const calendarSchema: SliceSchema = {
  name: "calendar",
  // Kinds of the prepared actions this slice creates. A period close and a reopening keep the core
  // kinds (closePeriod, reopenPeriod: `close`); adding fiscal years to the calendar is a change to
  // the book's configuration, like adding an account.
  preparedPermissions: { extendCalendar: "configure", changeYearStart: "configure" },
  definitions: {
    PeriodInput: object({
      periodId: id,
      operation: { type: "string", enum: ["close", "reopen"] },
      reason: reason(500),
    }),
    PeriodRow: object({
      id,
      label: text(80),
      startsOn: date,
      endsOn: date,
      // "closed" means locked: nothing can be posted into the period. It is the kernel's own rule,
      // true whether or not the period's close is current (see closeSuperseded).
      status: { type: "string", enum: ["open", "closed"] },
      // The close in force; null when the period is open or its close was superseded.
      closePackageId: nullable(id),
      reportPopulationHash: nullable(hash),
      closingRevision: nullable(revision),
      // The fiscal year the period belongs to (the calendar year in which that fiscal year starts)
      // and its 1-based position inside it.
      fiscalYear,
      ordinal: { type: "integer", minimum: 1, maximum: 366 },
      // The period's last day is before today.
      ended: { type: "boolean" },
      // Locked, but its close was superseded because an earlier period was reopened: the period
      // stays locked until it is reopened itself, and needs closing again to have a current close.
      closeSuperseded: { type: "boolean" },
      // The period ends before the day the books began (the recorded cutover date): it holds none of
      // the books' own activity, so it is not counted as open anywhere and a year-end closes it with
      // the rest. False when no cutover is recorded.
      beforeBooks: { type: "boolean" },
      // Nothing is recorded in the period: no entry is dated in it and no bank transaction in the
      // Inbox is dated in it, whatever became of that transaction. False when the Inbox could not be
      // read, so a period is never called empty by mistake. A run of empty periods that have ended
      // can be closed in one step, each in order.
      empty: { type: "boolean" },
      // The other periods whose current closes reopening this one would supersede (every closed
      // period that ends on or after it). They stay locked. Empty unless this period has a
      // current close.
      supersedes: array(id),
      // The same list under the name the first release gave it. Despite the name these periods are
      // NOT reopened: reopening supersedes their closes and leaves them locked. The name stays
      // because the contract is frozen; read `supersedes`.
      alsoReopens: array(id),
    }),
    PeriodHistory: object({
      periodId: id,
      kind: text(80),
      reason: text(500),
      recordedAt: text(80),
      bookRevision: revision,
      supersededCloseIds: array(id),
      // The periods those superseded closes belong to (never the period itself).
      supersededPeriodIds: array(id),
    }),
    FiscalYearRow: object({
      fiscalYear,
      startsOn: date,
      endsOn: date,
      // The periods that count: all but those before the books began (all of them when the whole
      // year is before the books began).
      periodCount: { type: "integer", minimum: 1 },
      // Counted periods locked with a current close, and counted periods locked whose close was
      // superseded.
      closedCount: count,
      supersededCount: count,
      // "closed" only when every counted period is locked with a current close.
      status: { type: "string", enum: ["open", "partlyClosed", "closed"] },
      ended: { type: "boolean" },
      // Every period of the year ends before the books began, so there is nothing in it to close.
      beforeBooks: { type: "boolean" },
      // How many periods of the year end before the books began and are not counted.
      periodsBeforeBooks: count,
    }),
    CalendarSummary: object({
      // Today as the book's owner reads a calendar, from the service clock. "Ended" is relative to it.
      today: date,
      firstDate: date,
      lastDate: date,
      fiscalYearStartMonth: { type: "integer", minimum: 1, maximum: 12 },
      periodModel,
      fiscalYears: array(ref("FiscalYearRow"), 101),
      canExtend: { type: "boolean" },
      // The fiscal year an extension adds first, and why there is none when canExtend is false.
      nextFiscalYear: nullable(fiscalYear),
      nextStartsOn: nullable(date),
      nextEndsOn: nullable(date),
      extendNote: text(300),
      // The day the books began: the recorded cutover date, or null when none is recorded.
      booksBegan: nullable(date),
      // Whether the month fiscal years start in can still be changed (periods.changeYearStart), and
      // why not when it cannot.
      canChangeYearStart: { type: "boolean" },
      yearStartNote: text(400),
    }),
    PeriodList: object({
      bookRevision: revision,
      calendar: ref("CalendarSummary"),
      periods: array(ref("PeriodRow")),
      history: array(ref("PeriodHistory")),
    }),
    PreparedCalendarPeriod: object({
      periodId: id,
      fiscalYear,
      label: text(80),
      startsOn: date,
      endsOn: date,
    }),
    PeriodsExtendInput: object({ through: fiscalYear }, []),
    PeriodsYearStartInput: object({
      fiscalYearStartMonth: { type: "integer", minimum: 1, maximum: 12 },
    }),
    YearEndInput: object({ fiscalYear, reason: reason(400) }),
    YearEndCheck: object({
      id: text(40),
      label: text(120),
      status: { type: "string", enum: ["pass", "attention"] },
      detail: text(600),
    }),
    YearEndStep: object({
      order: { type: "integer", minimum: 1 },
      periodId: id,
      label: text(80),
      startsOn: date,
      endsOn: date,
      // Locked or not, and for a locked period whether its close was superseded.
      status: { type: "string", enum: ["open", "closed"] },
      closeSuperseded: { type: "boolean" },
      // The commands that bring the period to a current close, in order: a close for an open period,
      // a reopening and then a close for a locked period whose close was superseded, and none for a
      // period that already has a current close. Each is sealed against the book as the commands
      // before it leave it, and is committed under its own hash.
      plans: array(ref("PreparedOperation"), 2),
    }),
    YearEndStatements: object({
      asOf: date,
      periodStart: date,
      currency: text(3),
      basis: { type: "string", enum: ["cash", "accrual"] },
      compilerVersion: text(80),
      populationHash: hash,
      debit: signedMoney,
      credit: signedMoney,
      balanced: { type: "boolean" },
      revenue: signedMoney,
      expenses: signedMoney,
      netIncome: signedMoney,
      assets: signedMoney,
      liabilities: signedMoney,
      equity: signedMoney,
      priorEarnings: signedMoney,
      currentEarnings: signedMoney,
    }),
    YearEndReviewInput: object({ fiscalYear }),
    YearEndPeriod: object({
      order: { type: "integer", minimum: 1 },
      periodId: id,
      label: text(80),
      startsOn: date,
      endsOn: date,
      status: { type: "string", enum: ["open", "closed"] },
      closeSuperseded: { type: "boolean" },
      ended: { type: "boolean" },
      beforeBooks: { type: "boolean" },
    }),
    YearEndReview: object({
      bookRevision: revision,
      today: date,
      fiscalYear,
      startsOn: date,
      endsOn: date,
      // Periods a year-end would close (open ones, and locked ones whose close was superseded),
      // how many of those are the superseded ones, and periods that already have a current close.
      openCount: count,
      supersededCount: count,
      closedCount: count,
      periods: array(ref("YearEndPeriod"), 100),
      checks: array(ref("YearEndCheck"), 20),
      statements: ref("YearEndStatements"),
    }),
    YearEndPlan: object({
      disposition: { type: "string", enum: ["prepared"] },
      operationId: id,
      planId: id,
      planHash: hash,
      bookRevision: revision,
      fiscalYear,
      startsOn: date,
      endsOn: date,
      reason: text(500),
      valid: { type: "boolean" },
      openCount: count,
      supersededCount: count,
      closedCount: count,
      diagnostics: array(text(2000)),
      problems: array(ref("Problem")),
      steps: array(ref("YearEndStep"), 100),
      checks: array(ref("YearEndCheck"), 20),
      statements: ref("YearEndStatements"),
    }),
    YearEndStepReceipt: object({
      periodId: id,
      // The command: a close, or the reopening that precedes the close of a superseded period.
      kind: { type: "string", enum: ["closePeriod", "reopenPeriod"] },
      disposition: { type: "string", enum: ["committed", "rejected", "skipped"] },
      outcomeSequence: nullable(revision),
      diagnostics: array(text(2000)),
      problems: array(ref("Problem")),
    }),
    YearEndReceipt: object({
      disposition: text(40),
      operationId: id,
      outcomeSequence: nullable(revision),
      diagnostics: array(text(2000)),
      problems: array(ref("Problem")),
      planId: id,
      planHash: hash,
      fiscalYear,
      // Periods whose close committed in this run, and the periods it set out to close.
      closedCount: count,
      totalCount: count,
      steps: array(ref("YearEndStepReceipt"), 200),
    }),
  },
  operations: [
    operation(
      "periods.list",
      "Inspect the fiscal calendar: every period with its fiscal year, whether it is open or closed (closed means locked against posting), whether it has ended, whether nothing is recorded in it (empty: no entry and no bank transaction dated in it), whether its close was superseded, and which other closes reopening it would supersede; each fiscal year's progress; whether and how the calendar can be extended; and the close and reopen history.",
      "read",
      "Empty",
      false,
      "PeriodList",
    ),
    operation(
      "periods.prepare",
      "Prepare the close or reopening of one period with an explicit reason. Reopening a period supersedes the closes of the later closed periods (the plan lists them): they stay locked until each is reopened itself, and every one needs closing again. Bringing a whole year to a current close, including re-closing superseded periods, is periods.yearEnd.",
      "close",
      "PeriodInput",
      true,
      "PreparedOperation",
    ),
    operation(
      "periods.extend",
      "Prepare adding fiscal years to the calendar so the book can be posted to later dates; omitted, one more fiscal year. Existing periods never change. Review the periods it adds, then commit the plan with operations.commit.",
      "configure",
      "PeriodsExtendInput",
      true,
      "PreparedOperation",
    ),
    operation(
      "periods.changeYearStart",
      "Prepare changing the month fiscal years start in. It draws the whole calendar again, so it is allowed only while the book has no entry and no closed period; after that the periods hold history and cannot be regrouped (set up a new book and bring the entries into it). The new calendar starts on the first day of the first fiscal year that begins on or after the old calendar's first day and ends where the new fiscal year containing the old last day ends. Review the periods it adds, then commit the plan with operations.commit.",
      "configure",
      "PeriodsYearStartInput",
      true,
      "PreparedOperation",
    ),
    operation(
      "periods.yearEndReview",
      "Read what closing one fiscal year would involve, without preparing anything: its periods in order with their status, a checklist (trial balance balances, profit and loss, every period ended, earlier years closed, no unposted drafts) and the year's statements. It changes and retains nothing; look before choosing a reason and calling periods.yearEnd.",
      "read",
      "YearEndReviewInput",
      false,
      "YearEndReview",
    ),
    operation(
      "periods.yearEnd",
      "Prepare the close of every open period of one fiscal year, in order. Each period's close is its own sealed command with its own plan and hash, sealed against the book as the closes before it leave it; the last close of the year records the year-end report population. Returns the checklist and the year's statements. Commit the whole plan with periods.commitYearEnd. No closing entries are posted: earnings roll forward by computation in the reports.",
      "close",
      "YearEndInput",
      true,
      "YearEndPlan",
    ),
    operation(
      "periods.commitYearEnd",
      "Commit a prepared year-end: every period close in order, each under its own plan hash. It stops at the first rejection and reports how many periods closed. Retry with the same operation identity to resume after an interruption; a close that already committed is never repeated.",
      "close",
      "CommitInput",
      true,
      "YearEndReceipt",
    ),
  ],
};

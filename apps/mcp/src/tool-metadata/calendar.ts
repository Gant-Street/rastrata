import type { ToolMetadata } from "./types.ts";

/** MCP tool metadata for the operations the calendar slice owns, keyed by operation name. Written for
 * a model: what each tool does, what it cannot do, and what to read first. */
export const calendarTools: Readonly<Record<string, ToolMetadata>> = {
  "periods.list": {
    name: "rastrata_list_periods",
    title: "Inspect the fiscal calendar and periods",
    description:
      "Start here for anything about closing, reopening or the calendar. Returns every period with its fiscal year, whether it is open or closed (closed means locked: nothing can be posted into it), whether it has ended (relative to today's date, which is returned), whether nothing is recorded in it (empty: no entry and no bank transaction dated in it), whether its close was superseded, and which other closes reopening it would supersede; each fiscal year's progress; the dates the calendar covers; whether and how it can be extended; and the close and reopen history. Read it before preparing a close, a reopening, a year-end or an extension, and when a posting fails with calendar_not_configured.",
  },
  "periods.prepare": {
    name: "rastrata_prepare_period_change",
    title: "Preview closing or reopening one period",
    description:
      "Prepare the close or the reopening of ONE period with an explicit reason; preparing changes nothing. Review valid, problems and warnings: closing a period that has not ended, or while an earlier period is open, is allowed but warned about, and a period that is already locked cannot be closed. Reopening a period supersedes the closes of the later closed periods (effects.periods[].supersededPeriodIds lists them): those periods stay LOCKED, but their recorded closes no longer match the books once the correction is made, and each needs closing again. Tell the user that before committing. To bring a whole fiscal year to a current close, including periods whose close was superseded, use rastrata_prepare_year_end instead of closing periods one at a time. To close the books through a month, as the Close the books screen does with one button: read rastrata_get_cutover_checklist for that period first and go on only when its verdict is ready, then prepare and commit each open period up to and including it in order, oldest first (the ones that hold nothing, empty in rastrata_list_periods, among them), and stop at the first the book refuses. Commit with rastrata_commit_operation after the user authorizes these exact effects; committing needs close permission.",
  },
  "periods.extend": {
    name: "rastrata_prepare_calendar_extension",
    title: "Preview adding fiscal years to the calendar",
    description:
      "Prepare adding fiscal years to the book's calendar so later dates can be posted; omit `through` to add one fiscal year (the year named by the calendar year in which it starts). Use it when a posting fails with calendar_not_configured and extendThrough names a year, or when the user asks to prepare the next year. It only adds periods after the calendar's last day: existing periods never change, and the book's first period cannot be moved, so an earlier date can never be posted. A year that is already covered is refused with calendar_already_covers. Review effects.calendar, then commit with rastrata_commit_operation after the user authorizes; committing needs configure permission.",
  },
  "periods.changeYearStart": {
    name: "rastrata_prepare_year_start_change",
    title: "Preview changing the month fiscal years start in",
    description:
      "Prepare changing the month the book's fiscal years start in (1 to 12; 10 is October). Use it only when the user says their fiscal year starts in another month than the book has: rastrata_list_periods reports calendar.fiscalYearStartMonth and canChangeYearStart. It draws the whole calendar again, so it is refused with year_start_has_entries once an entry is posted and with year_start_has_closes once a period has been closed: after that the periods are history, and the way is a new book with the right fiscal year that this book's entries are brought into. The new calendar starts on the first day of the first fiscal year that begins on or after the old calendar's first day and ends where the new fiscal year containing the old last day ends; the day the books began must fall inside it. Review effects.calendar, tell the user what changes, then commit with rastrata_commit_operation after the user authorizes; committing needs configure permission.",
  },
  "periods.yearEndReview": {
    name: "rastrata_review_year_end",
    title: "Review a fiscal year before closing it",
    description:
      "Read what closing one fiscal year would involve, without preparing anything: its periods in order with their status, a checklist (trial balance balances, profit and loss, every period ended, every close current, earlier years closed, no unposted drafts) and the year's statements. It changes and retains nothing, so use it freely. Also check reconciliation and the inbox with their own tools when this book has them, tell the user what needs attention, and only then ask for a reason and call rastrata_prepare_year_end. It gives no tax advice.",
  },
  "periods.yearEnd": {
    name: "rastrata_prepare_year_end",
    title: "Preview closing a whole fiscal year",
    description:
      "Prepare bringing every period of one fiscal year to a current close, in order, with one reason for the year. Returns a checklist, the year's statements, and for each period the commands that do it, each with its own plan, hash and warnings: a close for an open period, a reopening and then a close for a locked period whose close was superseded, none for a period that already has a current close. Nothing changes until rastrata_commit_year_end. Closing posts no entries and moves no balance: earnings roll forward by computation in the reports. Before committing, read every check and warning, check reconciliation and the inbox with their own tools when this book has them, show the user the statements and the periods, and get authorization for exactly these periods. Needs close permission and the calendar to cover the year.",
  },
  "periods.commitYearEnd": {
    name: "rastrata_commit_year_end",
    title: "Commit a prepared year-end",
    description:
      "Commit a prepared year-end: pass its planId and planHash exactly as returned. It runs every command in order, each under its own hash, and stops at the first one the book rejects (for example because the book changed after the review); closes already made stay closed and the reply says how many. It can take several seconds on a large book. If the reply is lost or the call times out, call this tool again with the SAME operationId and the same input: commands that already committed are never repeated. Never prepare a new year-end to recover an uncertain commit. Needs close permission and the user's authorization of the prepared periods.",
    destructive: true,
  },
};

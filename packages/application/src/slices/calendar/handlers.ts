import { describePrincipal } from "../../agent/principal.ts";
import { changeYearStartCommand, extendCalendarCommand } from "../../calendar/commands.ts";
import { planExtension } from "../../calendar/extend.ts";
import { ledgerShape, planYearStart } from "../../calendar/year-start.ts";
import type { ApplicationService } from "../../service.ts";
import { inboxLineDates } from "../ingest/store.ts";
import { booksBeganOn } from "../shadow/cutover-date.ts";
import type { SliceHandlers } from "../types.ts";
import { commitYearEnd, prepareYearEnd, reviewYearEnd } from "./year-end.ts";

/** The days the Inbox's bank transactions are dated on, for each period's `empty`. The Inbox that could
 * not be read is null, and then no period is called empty: the list still answers. */
function inboxDays(service: ApplicationService): readonly string[] | null {
  try {
    return inboxLineDates(service);
  } catch {
    return null;
  }
}

/** Prepare adding fiscal years to the calendar. Nothing changes until the plan is committed. */
function extendCalendar(
  service: ApplicationService,
  input: { through?: number },
  operationId: string,
) {
  const setup = service.setupState();
  if (!setup) throw new Error("Book is not configured");
  return service.executeAction(
    operationId,
    "extendCalendar",
    // The request as it was made, not as it resolves today: asking again with the same identity
    // returns the plan already made even after the calendar has grown.
    input,
    (state) =>
      extendCalendarCommand(
        state,
        { actionId: operationId, actor: service.commandActor },
        planExtension(state, ledgerShape(state, setup), setup.fiscalYear, input.through),
      ),
    true,
  );
}

/** Prepare drawing the calendar again under a new fiscal-year month. It is refused once the book has an
 * entry or a close; nothing changes until the plan is committed. */
function changeYearStart(
  service: ApplicationService,
  input: { fiscalYearStartMonth: number },
  operationId: string,
) {
  const setup = service.setupState();
  if (!setup) throw new Error("Book is not configured");
  const booksBegan = booksBeganOn(service);
  return service.executeAction(
    operationId,
    "changeYearStart",
    input,
    (state) =>
      changeYearStartCommand(
        state,
        { actionId: operationId, actor: service.commandActor },
        planYearStart(state, ledgerShape(state, setup), input.fiscalYearStartMonth, booksBegan),
      ),
    true,
  );
}

export const calendarHandlers: SliceHandlers = {
  "periods.list": (_input, { service }) => service.periods(inboxDays(service)),
  "periods.prepare": (input, { service, operationId }) =>
    service.changePeriod(
      {
        actionId: operationId,
        periodId: input.periodId as string,
        operation: input.operation as "close" | "reopen",
        reason: input.reason as string,
      },
      true,
    ),
  "periods.extend": (input, { service, operationId }) =>
    extendCalendar(service, input as { through?: number }, operationId),
  "periods.changeYearStart": (input, { service, operationId }) =>
    changeYearStart(service, input as { fiscalYearStartMonth: number }, operationId),
  "periods.yearEndReview": (input, { service }) =>
    reviewYearEnd(service, input as { fiscalYear: number }),
  "periods.yearEnd": (input, { service, operationId }) =>
    prepareYearEnd(service, input as { fiscalYear: number; reason: string }, operationId),
  "periods.commitYearEnd": (input, { service, access, operationId }) =>
    commitYearEnd(
      service,
      input as { planId: string; planHash: string },
      operationId,
      describePrincipal(access.principal),
    ),
};

import { periodViews, type PeriodView } from "../../calendar/periods.ts";
import { booksBeganOn } from "../shadow/cutover-date.ts";
import type { AdvisorContext, PlanWarning } from "../types.ts";

const MOST_NAMED = 6;
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** A period named so it is unambiguous in a book of several years. */
const name = (period: PeriodView) => `${period.label} ${period.startsOn.slice(0, 4)}`;
const span = (period: PeriodView) => `${period.startsOn} to ${period.endsOn}`;

/** What the calendar has to say about a plan that is being prepared. Advisory: it never blocks.
 * - Closing a period that has not ended, or while an earlier one is still open, is allowed but is
 *   usually a mistake, and it locks the period against new postings. A period before the books began
 *   (it ends before the recorded cutover date) holds none of the books' own activity, so leaving it
 *   open is not out of order.
 * - Closing a period that is already locked is refused by the kernel; the warning says why in terms a
 *   person can act on (it needs reopening first, or the year-end does it).
 * - Reopening a period supersedes the closes of every later closed period; they stay locked, and the
 *   warning says so, with the periods named. */
export function calendarAdvisor({ service, command, state }: AdvisorContext): PlanWarning[] {
  if (command.type !== "closePeriod" && command.type !== "reopenPeriod") return [];
  const views = periodViews(state, service.today(), booksBeganOn(service));
  const period = views.find((item) => item.id === command.periodId);
  if (!period) return [];
  const warnings: PlanWarning[] = [];
  if (command.type === "closePeriod") {
    if (period.closeSuperseded)
      return [
        {
          code: "close_superseded_period",
          message: `${name(period)} is still locked: its close was superseded when an earlier period was reopened, and a locked period cannot be closed again until it is reopened. Reopen it, then close it, or run the year-end, which does both in order.`,
        },
      ];
    if (period.status === "closed")
      return [
        {
          code: "period_already_closed",
          message: `${name(period)} (${span(period)}) is already closed. To correct it, reopen it first.`,
        },
      ];
    if (!period.ended)
      warnings.push({
        code: "period_not_ended",
        message: `${name(period)} (${span(period)}) has not ended: today is ${service.today()}. Closing it stops new postings dated in it.`,
      });
    const earlier = views.filter(
      (item) =>
        item.endsOn < period.startsOn &&
        !item.beforeBooks &&
        (item.status === "open" || item.closeSuperseded),
    );
    const oldest = earlier[0];
    if (oldest)
      warnings.push({
        code: "earlier_period_open",
        message: `${earlier.length} earlier ${plural(earlier.length, "period is", "periods are")} still open or ${plural(earlier.length, "needs", "need")} closing again, the oldest ${name(oldest)} (${span(oldest)}). Closing out of order leaves a gap in the locked books. Close earlier periods first, or close the whole year in order with periods.yearEnd.`,
      });
    return warnings;
  }
  if (period.supersedes.length > 0) {
    const named = period.supersedes
      .map((id) => views.find((item) => item.id === id))
      .filter((item): item is PeriodView => item !== undefined);
    const shown = named.slice(0, MOST_NAMED).map(name).join(", ");
    const more = named.length - MOST_NAMED;
    warnings.push({
      code: "reopen_supersedes_closes",
      message: `Reopening ${name(period)} supersedes the ${plural(named.length, "close", "closes")} of ${named.length} later closed ${plural(named.length, "period", "periods")}: ${shown}${more > 0 ? ` and ${more} more` : ""}. ${plural(named.length, "It stays", "They stay")} locked, but ${plural(named.length, "its recorded close no longer matches", "their recorded closes no longer match")} the books once you correct ${name(period)}; close ${plural(named.length, "it", "them")} again afterwards (the year-end does that in order).`,
    });
  }
  return warnings;
}

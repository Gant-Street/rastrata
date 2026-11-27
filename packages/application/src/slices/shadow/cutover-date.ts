import { addDays } from "../../calendar/fiscal-calendar.ts";
import type { ApplicationService } from "../../service.ts";
import { shadowStore } from "./store.ts";

/** The date recorded as the cutover, the day the books move to Rastrata, or null when none is.
 * For the lanes that start where the books start (Stripe's first day), which read it here instead
 * of reaching into this lane's tables. */
export const recordedCutoverDate = (service: ApplicationService): string | null =>
  shadowStore(service).cutover()?.cutoverOn ?? null;

/** The day the books began: the recorded cutover date when there is one (the day the books moved to
 * Rastrata), else the day the setup says they begin, else null (a book made before the setup could
 * say, which counts every period). Periods that end before it are not the books' own. A cutover is
 * not implied: recording one also expects an opening entry and starts the Inbox's sources, which a
 * book that simply begins on a date does not. */
export const booksBeganOn = (service: ApplicationService): string | null =>
  recordedCutoverDate(service) ?? service.setupState()?.booksStartOn ?? null;

/** How far back an entry may be dated, or null when nothing but the calendar limits it. A calendar can
 * start years before the books (every book made in the browser starts in 2000), so the first period is
 * no longer where dating stops, and a mistyped year would land in a year the books do not hold. The
 * floor is the day before the books began, where the opening balances stand, or the day before a
 * recorded cutover date that is earlier (moving the start back is how earlier years are brought in). A
 * book whose setup names no day has its calendar start where its books do: the calendar is the limit. */
export function postingFloor(
  service: ApplicationService,
): { readonly began: string; readonly floor: string } | null {
  const named = service.setupState()?.booksStartOn;
  if (named === undefined) return null;
  const cutover = recordedCutoverDate(service);
  const began = cutover !== null && cutover < named ? cutover : named;
  return { began, floor: addDays(began, -1) };
}

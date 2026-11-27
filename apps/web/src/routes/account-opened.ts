/** The day an account is shown as open: the day it opened, but never before the day the books began.
 * Accounts open on the first day of the calendar, and a calendar can start years before the books
 * (every book made in the browser starts in 2000), so "open since" would name a year the books never
 * held. A book that names no day has its calendar start where its books do, and shows the real day. */
export function openedForDisplay(openedOn: string, booksBegan: string | null | undefined): string {
  return booksBegan && openedOn < booksBegan ? booksBegan : openedOn;
}

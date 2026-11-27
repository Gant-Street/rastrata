/** Where the date of a new journal entry starts. Pure, so it can be tested: the clock and the book's
 * calendar are passed in.
 *
 * An entry is usually about today, so that is where it starts, held inside the book's calendar so the
 * date can always be posted: a calendar that has ended starts it on its last day, one that has not
 * begun on its first. The opening entry stands at the start of the books, so it starts on the day the
 * books began (a book that started early has a calendar that begins long before that day, so the first
 * day of the calendar is the answer only when no day is given). Before the calendar has been read there
 * is nothing to hold it inside, so an ordinary entry starts today and the opening entry on the first
 * day of the book. */
export function startingDate(input: {
  readonly opening: boolean;
  /** Today, `YYYY-MM-DD`. */
  readonly today: string;
  /** The first day of the books, used until the calendar is read. */
  readonly firstFiscalDay: string;
  readonly calendar?:
    | {
        readonly firstDate: string;
        readonly lastDate: string;
        /** The day the books began, when the book says. */
        readonly booksBegan?: string | null | undefined;
      }
    | undefined;
}): string {
  const { calendar, today } = input;
  if (input.opening) return calendar?.booksBegan ?? calendar?.firstDate ?? input.firstFiscalDay;
  if (!calendar) return today;
  if (today < calendar.firstDate) return calendar.firstDate;
  if (today > calendar.lastDate) return calendar.lastDate;
  return today;
}

/** Where the date of a reversal starts. A reversal cancels the entry in the same period when it can,
 * so the period's figures are right and not only the next one's: it starts on the entry's own date. When
 * that date is in a period that is closed, nothing can be posted there, so it starts today, held inside
 * the calendar like a new entry's date. Pure: the clock and the periods are passed in. */
export function reversalDate(input: {
  /** The date of the entry being reversed. */
  readonly entryDate: string;
  readonly today: string;
  readonly calendar?: { readonly firstDate: string; readonly lastDate: string } | undefined;
  /** The periods that are locked: nothing can be posted into them. */
  readonly locked: readonly { readonly startsOn: string; readonly endsOn: string }[];
}): string {
  const inLocked = input.locked.some(
    (period) => input.entryDate >= period.startsOn && input.entryDate <= period.endsOn,
  );
  if (!inLocked) return input.entryDate;
  return startingDate({
    opening: false,
    today: input.today,
    firstFiscalDay: input.entryDate,
    calendar: input.calendar,
  });
}

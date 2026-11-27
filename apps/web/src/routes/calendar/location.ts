/** What the Periods address says about the screen: which fiscal year is on show and whether the guided
 * year-end is open. It lets the Home card link straight to a year's closing, and lets a reload (or a
 * shared link) come back to the same place. Anything else in the address is ignored. */
export interface PeriodsLocation {
  readonly year: number | undefined;
  /** The guided year-end is open. */
  readonly yearEnd: boolean;
}

const YEAR = /^\d{4}$/;

export function parseLocation(search: string): PeriodsLocation {
  const params = new URLSearchParams(search);
  const year = params.get("year");
  return {
    year: year !== null && YEAR.test(year) ? Number(year) : undefined,
    yearEnd: params.get("flow") === "year-end",
  };
}

/** The query string for a state: empty when there is nothing to say, so the plain address stays plain. */
export function locationSearch(state: PeriodsLocation): string {
  const params = new URLSearchParams();
  if (state.year !== undefined) params.set("year", String(state.year));
  if (state.yearEnd) params.set("flow", "year-end");
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Link to a fiscal year's guided close, for the Home card and the Inbox. */
export const yearEndHref = (year: number): string =>
  `/periods${locationSearch({ year, yearEnd: true })}`;

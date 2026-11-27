import type { LaneUi } from "../registry.ts";

/** The chart lane's screens. The setup wizard is not a route: it is what Home shows before a book
 * exists (see setup-flow.tsx), and the Accounts screen is one of the application's core routes. What to
 * do next is not a status line either: Home shows the start of a new book (home-start.ts) while the
 * book is new, and the next step is the first row of "Needs you" after that. */
export const ui: LaneUi = { routes: [], homeCards: [] };

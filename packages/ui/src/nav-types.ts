/** What the main navigation, the section tabs and the Search palette are given. Plain types, so the web
 * application's logic (and its tests) can build the navigation without loading a component library.
 * The application derives all of it from the route registry (`apps/web/src/routes/registry.ts`). */

/** How a link relates to the page the person is on: `page` is this very page, `true` is the place it
 * belongs to (a section that holds the page, a tab a detail page sits under). */
export type NavCurrent = "page" | "true";

/** A section of the product, as the header lists it (Home, Transactions, Accounts, Reports, and Settings
 * on its own). */
export interface NavSectionEntry {
  readonly id: string;
  readonly label: string;
  /** Where the section's link goes: the page it opens on. */
  readonly path: string;
  /** A live count of what waits on that page (transactions for review). It is shown only above zero. */
  readonly count?: number | undefined;
  readonly current?: NavCurrent | undefined;
}

/** A tab in the row under the header, or an entry in the Settings list. */
export interface NavTab {
  readonly path: string;
  readonly label: string;
  /** A live count (what is waiting for review). It is shown only above zero. */
  readonly count?: number | undefined;
  readonly current?: NavCurrent | undefined;
}

/** One thing "+ New" can start. A destination has an `href`; a dialog has none, and the application
 * opens it when it is chosen. */
export interface NavActionEntry {
  readonly id: string;
  readonly label: string;
  readonly href?: string | undefined;
}

/** What a link is drawn from (a section, a tab or an action with a destination). */
export interface NavLinkEntry {
  readonly path: string;
  readonly label: string;
  readonly count?: number | undefined;
  readonly current?: NavCurrent | undefined;
}

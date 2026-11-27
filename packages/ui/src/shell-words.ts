/** Every word the application shell owns: the header, the section tabs, the page header and the Search
 * palette. A screen's own words are in its lane's `words.ts`; the names of the sections and of the pages
 * in them are in the web application's registry (`apps/web/src/routes/`). */
export const shellWords = {
  header: {
    navigation: "Main navigation",
    home: "Go to Home",
    menu: "Menu",
    menuClose: "Close menu",
    search: "Search",
    searchShortcut: "Open search",
    new: "New",
    newList: "Create something new",
    settings: "Settings",
    book: (name: string) => `Books of ${name}`,
  },
  tabs: {
    /** "Transactions pages": the name of the row of tabs under the header. */
    rowOf: (section: string) => `${section} pages`,
    count: (count: number) => `${count} waiting`,
  },
  back: { to: (label: string) => `Back to ${label}` },
  search: {
    title: "Search",
    label: "Search transactions, accounts, pages and actions",
    placeholder: "Search transactions, accounts, pages and actions",
    results: "Search results",
    close: "Close search",
    searching: "Searching…",
    none: (query: string) => `Nothing found for "${query}". Try a name, a code or a date.`,
    found: (count: number) => (count === 1 ? "1 result" : `${count} results`),
    failedSource: (name: string) => `${name} could not be searched.`,
    hint: "Up and down to move, Enter to open, Escape to close",
    footerMove: "to move",
    footerOpen: "to open",
    footerClose: "to close",
  },
  settingsNav: { label: "Settings" },
} as const;

export type ShellWords = typeof shellWords;

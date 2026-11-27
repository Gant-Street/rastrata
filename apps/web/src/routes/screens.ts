/** The application's own screens, each fetched when it is first wanted (screen.ts). Home is not here: it is what the first draw is, and it is in the page's first script. The router
 * (router.tsx) and the registry of the places (core.ts) hold these same ones, so that the file of a screen is asked for once, whoever asks first. */
import { screen } from "./screen.ts";

export const AccountsPage = screen(() => import("./accounts.tsx"), "AccountsPage");
export const JournalPage = screen(() => import("./journal.tsx"), "JournalPage");
export const JournalDetailPage = screen(() => import("./journal-detail.tsx"), "JournalDetailPage");
export const NewJournal = screen(() => import("./journal-new.tsx"), "NewJournal");
export const LedgerPage = screen(() => import("./ledger.tsx"), "LedgerPage");
export const PeriodsPage = screen(() => import("./periods.tsx"), "PeriodsPage");
export const ReportsPage = screen(() => import("./reports.tsx"), "ReportsPage");

import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const CutoverRedirect = screen(() => import("./cutover-redirect.tsx"), "CutoverRedirect");
const GapsPage = screen(() => import("./gaps-page.tsx"), "GapsPage");
const OpeningPage = screen(() => import("./opening-page.tsx"), "OpeningPage");
const TieoutPage = screen(() => import("./tieout-page.tsx"), "TieoutPage");
const XeroPage = screen(() => import("./xero-page.tsx"), "XeroPage");

/** The shadow lane's screens, the move from another system. `/cutover` was the month checklist, which is
 * on Close the books now, and opens that page; the opening balances, with the start date, are one of the three ways on Settings,
 * Bring in your books; the three Xero screens (import, compare, things to check) are the three steps of
 * Move from Xero. */
export const ui: LaneUi = {
  routes: [
    {
      path: "/cutover",
      component: CutoverRedirect,
      nav: { section: "settings", parent: "/periods" },
    },
    {
      path: "/opening",
      component: OpeningPage,
      nav: {
        section: "settings",
        label: "Start date and opening balances",
        parent: "/settings/bring-in",
        keywords: ["opening balances", "cutover", "start date", "conversion date", "starting"],
      },
    },
    {
      path: "/xero",
      component: XeroPage,
      nav: {
        section: "settings",
        label: "Import from Xero",
        parent: "/settings/bring-in",
        keywords: ["xero", "import from xero", "migrate", "switch"],
      },
    },
    {
      path: "/tie-out",
      component: TieoutPage,
      nav: {
        section: "settings",
        label: "Compare with Xero",
        parent: "/settings/bring-in",
        keywords: ["xero", "compare", "tie-out"],
      },
    },
    {
      path: "/gaps",
      component: GapsPage,
      nav: {
        section: "settings",
        label: "Things to check",
        parent: "/settings/bring-in",
        keywords: ["xero", "gaps", "differences"],
      },
    },
  ],
  homeCards: [],
};

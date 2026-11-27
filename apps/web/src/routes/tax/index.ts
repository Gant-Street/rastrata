import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const TaxPage = screen(() => import("./page.tsx"), "TaxPage");

/** Taxes is a page under Reports: the list's Tax time group opens it on each of its five tools (worksheet,
 * year-end pack, 1099 vendors, sales tax, accountant pack). */
export const ui: LaneUi = {
  routes: [
    {
      path: "/tax",
      component: TaxPage,
      nav: {
        section: "reports",
        label: "Taxes",
        parent: "/reports",
        keywords: [
          "tax",
          "1099",
          "schedule c",
          "sales tax",
          "year-end pack",
          "accountant pack",
          "worksheet",
        ],
      },
    },
  ],
  homeCards: [],
};

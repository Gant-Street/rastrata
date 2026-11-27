import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const PayeesPage = screen(() => import("./page.tsx"), "PayeesPage");

/** Money by payee: a page under Reports, in the list's Detail group. Who the book paid and was paid by, with one name for each, and the
 * means to name a payee out of the bank texts nobody has named. It adds up to the profit and loss. */
export const ui: LaneUi = {
  routes: [
    {
      path: "/reports/payees",
      component: PayeesPage,
      nav: {
        section: "reports",
        label: "Money by payee",
        parent: "/reports",
        keywords: [
          "payee",
          "payees",
          "money by payee",
          "who i paid",
          "who paid me",
          "vendors",
          "customers",
          "suppliers",
          "name a payee",
          "not named yet",
        ],
      },
    },
  ],
  homeCards: [],
};

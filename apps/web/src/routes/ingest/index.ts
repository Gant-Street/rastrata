import { reviewCount, reviewSource } from "../../search/sources.ts";
import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const InboxPage = screen(() => import("./page.tsx"), "InboxPage");

// The Inbox is "For review" in the app: the first view of Transactions, the page the place opens, with the
// number waiting beside the place's name in the bar. All transactions and Rules are pages under it, reached
// from the page's own switch and its header, so the place has no row of tabs. (The CLI, the API and the
// explanation pages keep "inbox".)
export const ui: LaneUi = {
  routes: [
    {
      path: "/inbox",
      component: InboxPage,
      nav: {
        section: "transactions",
        label: "Transactions",
        order: 10,
        keywords: [
          "for review",
          "inbox",
          "bank transactions",
          "categorize",
          "accept",
          "waiting",
          "to review",
        ],
        count: reviewCount,
      },
    },
  ],
  homeCards: [],
  searchSources: [reviewSource],
};

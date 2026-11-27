import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const ChangesPage = screen(() => import("./page.tsx"), "ChangesPage");

export const ui: LaneUi = {
  routes: [
    {
      path: "/changes",
      component: ChangesPage,
      nav: {
        // The record of who changed what is where QuickBooks keeps its audit log and Xero its history:
        // an entry of Settings, the last.
        section: "settings",
        label: "Changes",
        order: 80,
        keywords: [
          "changes",
          "history",
          "audit",
          "activity",
          "what changed",
          "who did this",
          "looked at",
          "agent did",
        ],
      },
    },
  ],
  homeCards: [],
};

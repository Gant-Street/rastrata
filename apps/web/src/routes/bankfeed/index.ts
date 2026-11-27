import { whenTheServiceCan } from "../../service-needs.tsx";
import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const BankfeedPage = screen(() => import("./page.tsx"), "BankfeedPage");

// The bank connection is one of the two cards on Settings, Connections; its page sits under that one.
export const ui: LaneUi = {
  routes: [
    {
      path: "/settings/bankfeed",
      component: whenTheServiceCan("connections", BankfeedPage),
      nav: { section: "settings", parent: "/settings/connections", needs: "connections" },
    },
  ],
  homeCards: [],
};

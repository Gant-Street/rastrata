import { whenTheServiceCan } from "../../service-needs.tsx";
import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const BanksPage = screen(() => import("./page.tsx"), "BanksPage");

// The hosted service's bank connections: an owner connects a bank in Stripe's window, and chooses which account in the books each of its accounts belongs to. The page sits under Accounts
// ("Connect a bank" in that page's head opens it, and Search finds it by name), only where the service can connect a bank (the control plane has Stripe's keys); on a service that keeps a
// credential beside the book, the SimpleFIN bank connection is Settings, Connections. Its address is what it always was.
export const ui: LaneUi = {
  routes: [
    {
      path: "/settings/banks",
      component: whenTheServiceCan("banks", BanksPage),
      nav: {
        section: "accounts",
        label: "Bank accounts",
        parent: "/accounts",
        needs: "banks",
        keywords: [
          "bank",
          "bank feed",
          "connect",
          "transactions",
          "link",
          "stripe",
          "checking",
          "card",
        ],
      },
    },
  ],
  homeCards: [],
};

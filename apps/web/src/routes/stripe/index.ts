import { whenTheServiceCan } from "../../service-needs.tsx";
import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const StripePage = screen(() => import("./page.tsx"), "StripePage");

// Stripe is one of the two cards on Settings, Connections; its page sits under that one. Where the service keeps no credential and so has no Connections page (a hosted one), the page
// sits under Accounts, where Stripe has its row: an owner connects Stripe with the button there. Its address is what it always was.
export const ui: LaneUi = {
  routes: [
    {
      path: "/settings/stripe",
      component: whenTheServiceCan("stripe", StripePage),
      nav: { section: "settings", parent: "/settings/connections", needs: "connections" },
    },
    {
      path: "/settings/stripe",
      component: whenTheServiceCan("stripe", StripePage),
      nav: {
        section: "accounts",
        label: "Stripe",
        parent: "/accounts",
        needs: "stripeApp",
        keywords: ["stripe", "payouts", "connect", "sales", "fees"],
      },
    },
  ],
  homeCards: [],
};

import { whenTheServiceCan } from "../../service-needs.tsx";
import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const BillingPage = screen(() => import("./page.tsx"), "BillingPage");

// The hosted service's billing: how a workspace stands as to its trial and subscription, and, for an owner, subscribing on Stripe's page and managing the subscription in Stripe's portal. The page is
// in Settings and only where the service charges for workspaces (the control plane has Stripe's keys); the banner that tells everyone in the last days of a trial is the shell's.
export const ui: LaneUi = {
  routes: [
    {
      path: "/settings/billing",
      component: whenTheServiceCan("billing", BillingPage),
      nav: {
        section: "settings",
        label: "Billing",
        order: 40,
        needs: "billing",
        keywords: [
          "billing",
          "subscription",
          "subscribe",
          "trial",
          "plan",
          "payment",
          "card",
          "invoice",
          "price",
          "stripe",
        ],
      },
    },
  ],
  homeCards: [],
};

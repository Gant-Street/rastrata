import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const ReconcileDetailPage = screen(() => import("./detail.tsx"), "ReconcileDetailPage");
const ReconcilePage = screen(() => import("./page.tsx"), "ReconcilePage");
const StartReconciliation = screen(() => import("./start.tsx"), "StartReconciliation");

export const ui: LaneUi = {
  routes: [
    {
      path: "/reconcile",
      component: ReconcilePage,
      // A named page under Accounts: each bank and card account has Reconcile on its row there, and this
      // page (every account, and the reconciliations made so far) is found by Search and by its address.
      nav: {
        section: "accounts",
        label: "Reconcile",
        parent: "/accounts",
        keywords: ["statement", "bank balance", "match", "check"],
      },
    },
    {
      path: "/reconcile/$id",
      component: ReconcileDetailPage,
      nav: { section: "accounts", parent: "/reconcile" },
    },
  ],
  homeCards: [],
  // "Reconcile an account" is a small form that opens over any page, then opens the reconciliation it makes.
  // The Reconcile page has the button; Search finds it by name.
  dialogs: [{ id: "reconcile-account", component: StartReconciliation }],
  newActions: [
    {
      id: "reconcile-account",
      label: "Reconcile an account",
      order: 70,
      searchOnly: true,
      dialog: "reconcile-account",
      keywords: ["statement", "check", "bank balance"],
    },
  ],
};

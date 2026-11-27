import { whenTheServiceCan } from "../../service-needs.tsx";
import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const HistoryPage = screen(() => import("../history/page.tsx"), "HistoryPage");
const BringInPage = screen(() => import("./bring-in.tsx"), "BringInPage");
const BusinessPage = screen(() => import("./business.tsx"), "BusinessPage");
const ConnectionsPage = screen(() => import("./connections.tsx"), "ConnectionsPage");
const MembersPage = screen(() => import("./members.tsx"), "MembersPage");
const WorkspacePage = screen(() => import("./workspace.tsx"), "WorkspacePage");

/** The Settings hub: Business (the facts of the book and the theme; Workspace, the export and the
 * deletion, is opened from it), Members (who has access, on a service with accounts), Connections (the
 * bank connection and Stripe, each linking to its page, on a service that can keep their credentials) and
 * Bring in your books (the start date and opening balances, history from a file, and the move from Xero,
 * each a page of its own under it). The other Settings pages are their own lanes' (Agents, Billing, Bank
 * accounts, Stripe, Backups and export, Close the books, Changes). */
export const ui: LaneUi = {
  routes: [
    {
      path: "/settings",
      component: BusinessPage,
      nav: {
        section: "settings",
        label: "Business",
        order: 10,
        keywords: ["business name", "fiscal year", "currency", "theme", "dark mode", "appearance"],
      },
    },
    {
      path: "/settings/members",
      component: MembersPage,
      nav: {
        section: "settings",
        label: "Members",
        order: 20,
        needs: "accounts",
        keywords: ["people", "team", "users", "invite", "access", "roles", "workspace", "leave"],
      },
    },
    {
      path: "/settings/workspace",
      component: WorkspacePage,
      nav: {
        section: "settings",
        label: "Workspace",
        parent: "/settings",
        needs: "accounts",
        keywords: ["export", "download", "take my data", "backup", "delete", "workspace"],
      },
    },
    {
      path: "/settings/connections",
      component: whenTheServiceCan("connections", ConnectionsPage),
      nav: {
        section: "settings",
        label: "Connections",
        order: 54,
        needs: "connections",
        keywords: ["bank connection", "bank feed", "stripe", "simplefin", "link"],
      },
    },
    {
      path: "/settings/bring-in",
      component: BringInPage,
      nav: {
        section: "settings",
        label: "Bring in your books",
        order: 60,
        keywords: [
          "import",
          "migrate",
          "switch",
          "opening balances",
          "history",
          "xero",
          "quickbooks",
          "old books",
        ],
      },
    },
    {
      path: "/settings/history",
      component: HistoryPage,
      nav: {
        section: "settings",
        label: "Bring in history",
        parent: "/settings/bring-in",
        keywords: [
          "import",
          "journal",
          "general ledger",
          "past years",
          "previous years",
          "quickbooks",
          "old books",
          "history",
        ],
      },
    },
    {
      path: "/settings/move",
      // The page that listed Xero's three steps is Bring in your books now; its address still opens.
      component: BringInPage,
      nav: {
        section: "settings",
        label: "Move from Xero",
        parent: "/settings/bring-in",
        keywords: ["xero", "import from xero", "migrate", "switch", "compare", "tie-out"],
      },
    },
  ],
  homeCards: [],
};

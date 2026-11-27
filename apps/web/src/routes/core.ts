import { accountsSource, transactionsSource } from "../search/sources.ts";
import { Home } from "./home.tsx";
import type { LaneUi } from "./registry.ts";
import {
  AccountsPage,
  JournalDetailPage,
  JournalPage,
  LedgerPage,
  NewJournal,
  PeriodsPage,
  ReportsPage,
} from "./screens.ts";

/** The application's own screens: Home, the list of all transactions and its entries, the Chart of
 * accounts and its register, Close the books, Reports. They are in the router with every lane's routes;
 * this file is where they say which place and tab they belong to. (The map, from the plan of 2026-11-11,
 * docs/reference/ux-simplify-plan.md: Home, Transactions, Accounts, Reports; Close the books is a page of
 * Settings.) */
export const ui: LaneUi = {
  routes: [
    { path: "/", component: Home, nav: { section: "home", label: "Home", order: 0 } },
    {
      path: "/journal",
      component: JournalPage,
      nav: {
        section: "transactions",
        label: "All transactions",
        parent: "/inbox",
        keywords: ["journal", "entries", "register", "find", "reverse", "undo", "posted"],
      },
    },
    {
      path: "/journal/new",
      component: NewJournal,
      nav: { section: "transactions", parent: "/journal" },
    },
    {
      path: "/journal/$entryId",
      component: JournalDetailPage,
      nav: { section: "transactions", parent: "/journal" },
    },
    {
      path: "/accounts",
      component: AccountsPage,
      nav: {
        section: "accounts",
        label: "Accounts",
        order: 10,
        keywords: [
          "chart of accounts",
          "accounts",
          "categories",
          "new account",
          "tax line",
          "register",
          "ledger",
        ],
      },
    },
    {
      path: "/ledger",
      component: LedgerPage,
      nav: { section: "accounts", parent: "/accounts" },
    },
    {
      path: "/periods",
      component: PeriodsPage,
      nav: {
        section: "settings",
        label: "Close the books",
        order: 70,
        keywords: ["periods", "lock", "close", "month end", "fiscal year", "cutover", "reopen"],
      },
    },
    {
      path: "/reports",
      component: ReportsPage,
      nav: {
        section: "reports",
        label: "Reports",
        order: 10,
        keywords: [
          "profit and loss",
          "income statement",
          "balance sheet",
          "cash flow",
          "trial balance",
          "general ledger",
        ],
      },
    },
  ],
  homeCards: [],
  newActions: [
    {
      id: "journal-entry",
      label: "Journal entry",
      order: 40,
      href: "/journal/new",
      keywords: [
        "manual",
        "debit",
        "credit",
        "transaction",
        "adjusting",
        "adjustment",
        "correction",
      ],
    },
    {
      id: "account",
      label: "Account",
      order: 50,
      href: "/accounts?new=1",
      keywords: ["chart of accounts", "category", "new account", "bank account", "credit card"],
    },
  ],
  searchSources: [transactionsSource, accountsSource],
};

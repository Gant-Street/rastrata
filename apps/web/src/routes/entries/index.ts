import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";
import { ENTRY_ACTIONS } from "./actions.ts";

const ReceiveMoneyDialog = screen(() => import("./dialogs.tsx"), "ReceiveMoneyDialog");
const SpendMoneyDialog = screen(() => import("./dialogs.tsx"), "SpendMoneyDialog");
const TransactionDialog = screen(() => import("./dialogs.tsx"), "TransactionDialog");
const TransferDialog = screen(() => import("./dialogs.tsx"), "TransferDialog");

/** The entries lane: one form for money out, in and between accounts, opened from "+ New, Transaction"
 * (and, on a kind of its own, from Search by "Spend money", "Receive money" or "Transfer", or `?new=spend`
 * in the address) as a dialog over whatever page the person is on. It has no routes of its
 * own: the Business form is a page of Settings, and Undo is an action on For review's transactions. */
export const ui: LaneUi = {
  routes: [],
  homeCards: [],
  newActions: ENTRY_ACTIONS,
  dialogs: [
    { id: "transaction", component: TransactionDialog },
    { id: "receive", component: ReceiveMoneyDialog },
    { id: "spend", component: SpendMoneyDialog },
    { id: "transfer", component: TransferDialog },
  ],
};

import type { NewAction } from "../registry-types.ts";

/** What the entries lane offers by name. "+ New" lists one, Transaction: the form for money out, in or
 * between accounts, which opens on Spend money. Its three kinds are found by Search under their own names
 * and open the same form on that kind; the keywords are the other words people use for each, so Search
 * finds Spend money by "expense" or "owner took money out". A plain module with no screens in it, so a
 * test can read it without loading them. */
export const ENTRY_ACTIONS: readonly NewAction[] = [
  {
    id: "transaction",
    label: "Transaction",
    order: 10,
    dialog: "transaction",
    keywords: ["money in", "money out", "record", "cash", "manual"],
  },
  {
    id: "spend",
    label: "Spend money",
    order: 20,
    searchOnly: true,
    dialog: "spend",
    keywords: ["expense", "purchase", "bought", "paid", "owner took money out", "owner's draw"],
  },
  {
    id: "receive",
    label: "Receive money",
    order: 25,
    searchOnly: true,
    dialog: "receive",
    keywords: ["income", "deposit", "paid me", "customer payment", "owner put money in"],
  },
  {
    id: "transfer",
    label: "Transfer",
    order: 30,
    searchOnly: true,
    dialog: "transfer",
    keywords: ["move money", "between accounts", "savings", "pay credit card"],
  },
];

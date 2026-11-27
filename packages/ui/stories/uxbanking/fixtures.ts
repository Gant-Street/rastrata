import type { BankTileData, BankTileLinks } from "../../src";

/** Fictional accounts for the bank tile stories. Nothing here is real. Balances are exact two-place
 * text, signed from the account's own side: the card owes 1,250.00, so it holds -1,250.00. */
export const checking: BankTileData = {
  accountId: "acc_1000",
  code: "1000",
  name: "Business checking",
  kind: "bank",
  bookBalance: "20729.65",
  statementBalance: "21004.15",
  statementAsOf: "2026-03-20",
  statementSource: "statement",
  toReview: 8,
  imported: true,
  lastReconciled: { date: "2026-02-28", balance: "18200.40" },
};

export const savings: BankTileData = {
  accountId: "acc_1010",
  code: "1010",
  name: "Business savings",
  kind: "bank",
  bookBalance: "6000.00",
  toReview: 0,
  imported: false,
};

export const card: BankTileData = {
  accountId: "acc_2000",
  code: "2000",
  name: "Business credit card",
  kind: "card",
  bookBalance: "-1250.00",
  toReview: 0,
  imported: true,
};

export const stripeIdle: BankTileData = {
  accountId: "acc_1100",
  code: "1100",
  name: "Stripe",
  kind: "stripe",
  bookBalance: null,
  toReview: 0,
  imported: false,
  connection: { kind: "stripe", state: "not_connected" },
};

/** A key that works, and the accounts Stripe is booked to not chosen yet: the next step, not a fault. */
export const stripeSetup: BankTileData = {
  accountId: "",
  code: "",
  name: "Stripe",
  kind: "stripe",
  bookBalance: null,
  toReview: 0,
  imported: false,
  connection: { kind: "stripe", state: "setup" },
};

export const stripeConnected: BankTileData = {
  accountId: "acc_1100",
  code: "1100",
  name: "Stripe",
  kind: "stripe",
  bookBalance: "0.00",
  statementBalance: "2431.17",
  statementAsOf: "2026-10-04T09:12:00.000Z",
  statementSource: "feed",
  toReview: 3,
  imported: true,
  connection: { kind: "stripe", state: "connected", syncedAt: "2026-10-04T09:12:00.000Z" },
};

export const feedChecking: BankTileData = {
  ...checking,
  statementSource: "feed",
  statementAsOf: "2026-10-04",
  toReview: 0,
  connection: { kind: "feed", state: "connected", syncedAt: "2026-10-04T08:00:00.000Z" },
};

export const feedBroken: BankTileData = {
  ...checking,
  accountId: "acc_1001",
  name: "Rho business checking",
  toReview: 2,
  connection: { kind: "feed", state: "attention", syncedAt: "2026-10-01T08:00:00.000Z" },
};

export const everyKind: readonly BankTileData[] = [checking, savings, card, stripeIdle];

export const reviewed: readonly BankTileData[] = [
  {
    ...checking,
    toReview: 0,
    statementBalance: "20729.65",
    lastReconciled: { date: "2026-03-20", balance: "20729.65" },
  },
  { ...savings, imported: true, lastReconciled: { date: "2026-03-20", balance: "6000.00" } },
  { ...card, lastReconciled: { date: "2026-03-20", balance: "-1250.00" } },
];

export const longNames: readonly BankTileData[] = [
  {
    ...checking,
    name: "Operating account for the Willow Lane Studio downtown location and its two satellite studios",
    bookBalance: "1234567890.12",
  },
  { ...savings, name: "Reserve" },
];

export const manyAccounts: readonly BankTileData[] = [
  checking,
  { ...savings, accountId: "acc_1011", name: "Tax reserve", imported: true, toReview: 2 },
  { ...savings, accountId: "acc_1012", name: "Payroll", bookBalance: "12800.00" },
  card,
  { ...card, accountId: "acc_2001", name: "Travel card", bookBalance: "-310.55", toReview: 5 },
  { ...checking, accountId: "acc_1013", name: "Rho business checking", toReview: 0 },
  stripeConnected,
];

/** The first account's name is Arabic: it is shown with its own direction, and the figure beside it
 * keeps its digits in order. */
export const rightToLeft: readonly BankTileData[] = [{ ...checking, name: "حساب الشركة" }, savings];

export const links: BankTileLinks = {
  open: (tile) => `#account-${tile.accountId || tile.kind}`,
  connect: (tile) => `#connect-${tile.kind}`,
};

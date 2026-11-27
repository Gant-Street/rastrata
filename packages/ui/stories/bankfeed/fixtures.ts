import type {
  BankfeedAccountView,
  BankfeedAttentionView,
  BankfeedChartOption,
  BankfeedRequestsView,
  BankfeedRunView,
  BankfeedSettingsView,
} from "../../src";

/** Fictional: a business with a checking account, a savings account and an account in euros. Nothing
 * here is a real bank, account or business. */

export const chart: readonly BankfeedChartOption[] = [
  { value: "acc-1000", label: "1000 · Business Checking" },
  { value: "acc-1100", label: "1100 · Business Savings" },
  { value: "acc-2000", label: "2000 · Company Card" },
];

export const linkedChecking: BankfeedAccountView = {
  id: "ACT-checking-0001",
  name: "Business Checking",
  bank: "Example Bank",
  currency: "USD",
  foreignCurrency: false,
  balance: "6878.18",
  balanceOn: "2026-10-04",
  state: "linked",
  unsupported: null,
  link: {
    ledgerAccountId: "acc-1000",
    ledgerAccount: "1000 Business Checking",
    startOn: "2026-09-01",
    through: "2026-10-04",
    lastSyncAt: "2026-10-04T13:01:00.000Z",
    lastError: null,
    feedBalance: {
      asOf: "2026-10-04",
      reported: "6878.18",
      ledger: "0.00",
      waiting: "5878.18",
      excluded: "0.00",
      difference: "1000.00",
    },
  },
};

const checkingLink = linkedChecking.link as NonNullable<BankfeedAccountView["link"]>;

export const linkedTied: BankfeedAccountView = {
  ...linkedChecking,
  link: {
    ...checkingLink,
    feedBalance: {
      asOf: "2026-10-04",
      reported: "6878.18",
      ledger: "6878.18",
      waiting: "0.00",
      excluded: "0.00",
      difference: "0.00",
    },
  },
};

export const unlinkedSavings: BankfeedAccountView = {
  id: "ACT-savings-0002",
  name: "Business Savings",
  bank: "Example Bank",
  currency: "USD",
  foreignCurrency: false,
  balance: "10001.20",
  balanceOn: "2026-10-04",
  state: "unlinked",
  unsupported: null,
  link: null,
};

export const unlinkedEuro: BankfeedAccountView = {
  id: "ACT-euro-0003",
  name: "Euro Account",
  bank: "Example Euro Bank",
  currency: "EUR",
  foreignCurrency: true,
  balance: "250.00",
  balanceOn: "2026-10-04",
  state: "unlinked",
  unsupported: null,
  link: null,
};

export const unsupportedCustom: BankfeedAccountView = {
  id: "ACT-points-0004",
  name: "Rewards Points",
  bank: "Example Bank",
  currency: "https://example.invalid/points",
  foreignCurrency: false,
  balance: "1200.00",
  balanceOn: "2026-10-04",
  state: "unsupported",
  unsupported:
    "This account is in a custom currency (an address, not a national currency), which Rastrata cannot book.",
  link: null,
};

export const goneAccount: BankfeedAccountView = {
  ...linkedChecking,
  id: "ACT-old-0005",
  name: "Old Checking",
  state: "gone",
  balance: null,
  balanceOn: null,
  link: { ...checkingLink, feedBalance: null },
};

export const requests: BankfeedRequestsView = {
  used: 5,
  limit: 24,
  budget: 20,
  freesAt: "2026-10-05T07:00:00.000Z",
  pausedUntil: null,
};

export const run: BankfeedRunView = {
  id: "run-1",
  startedAt: "2026-10-04T13:00:55.000Z",
  finishedAt: "2026-10-04T13:01:00.000Z",
  disposition: "complete",
  trigger: "manual",
  requests: 2,
  newLines: 11,
  duplicateLines: 0,
  pendingSkipped: 0,
  heldLines: 0,
  errorCode: null,
  errorMessage: null,
  notes: ["11 lines queued in the Inbox for review. Nothing was posted."],
};

export const failedRun: BankfeedRunView = {
  ...run,
  id: "run-2",
  disposition: "failed",
  newLines: 0,
  requests: 1,
  errorCode: "bankfeed_unavailable",
  errorMessage:
    "The SimpleFIN Bridge could not be reached. Nothing was read. Try again in a few minutes.",
  notes: [],
};

export const scheduledRun: BankfeedRunView = {
  ...run,
  id: "run-3",
  trigger: "scheduled",
  startedAt: "2026-10-03T06:17:02.000Z",
  finishedAt: "2026-10-03T06:17:07.000Z",
  newLines: 3,
  notes: [],
};

export const attention: readonly BankfeedAttentionView[] = [
  {
    code: "bridge_connection",
    severity: "error",
    message:
      "Example Bank needs you to sign in again at the SimpleFIN Bridge before it can be read. Sign in at the Bridge and re-enter the bank's credentials there.",
  },
  {
    code: "transactions_held",
    severity: "warning",
    message:
      "1 transaction could not be read exactly and was not imported. Import that period from a statement file, or add it by hand; the feed balance will keep showing the difference until you do.",
  },
  {
    code: "unlinked_accounts",
    severity: "info",
    message: "2 accounts are not linked. Unlinked accounts are never fetched.",
  },
];

export const dailyOff: BankfeedSettingsView = { dailySync: false, dailyAt: "06:17" };
export const dailyOn: BankfeedSettingsView = { dailySync: true, dailyAt: "07:42" };

import { formatCount, formatDate, formatInstant } from "../format";
import type { BankfeedAccountState, BankfeedRunView } from "./types";

/** Every sentence the Bank connection screen says, in one place. Plain and specific: what it does, what it
 * costs, what it cannot promise. The bank connection is a third-party service that reads the owner's banks
 * through an aggregator; the screen never makes it sound like less than that. */

const plural = (n: number, one: string, many: string): string =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

export const words = {
  eyebrow: "Settings",
  title: "Bank connection",
  pageLine: "Imports your bank's posted transactions for you to review. Nothing is posted.",
  intro:
    "Fill your books from your bank without downloading statements. Rastrata reads the posted transactions of the accounts you choose through the SimpleFIN Bridge and imports them for you to review. It never posts anything and never changes anything at your bank. Statement files still work and stay the fallback.",

  // ---- Not connected: what it is, before anything is asked -------------------------------------------
  connectionTitle: "Connection",
  beforeSummary: "Before you connect: what it costs, who sees your data, and how to connect",
  whatTitle: "What you are agreeing to",
  whatPoints: [
    "The SimpleFIN Bridge is a separate paid service. Your bank data passes through it and through the aggregator it uses (MX) on its way here. Read the Bridge's privacy and security pages before you decide.",
    "It costs money: about $15 a year when this was written. Check the Bridge's own page for the price today.",
    "Whether your bank works depends on the bank, and business accounts are covered less often than personal ones. Search the Bridge's list of banks before you pay.",
    "The Bridge expects about 24 requests a day and disables an access that asks too often. Rastrata counts every request and stops at 20 in any 24 hours.",
  ] as readonly string[],
  stepsTitle: "How to connect",
  steps: [
    "Create an account at the SimpleFIN Bridge, add your bank there, and create a setup token.",
    "Paste the setup token. It works once.",
    "Choose which accounts to read and which chart account each is recorded to.",
  ] as readonly string[],
  tokenLabel: "Setup token",
  tokenHint:
    "Paste it here and nowhere else: never into a chat or a message. Rastrata trades it for an access URL and saves that in a private file on this computer, in no backup and no export. The field is cleared as soon as you connect, and the token is never shown again.",
  tokenMissing: "Paste the setup token first.",
  connect: "Connect",
  connecting: "Connecting…",
  connectFailed: "The bank connection could not be made",
  connectUncertain:
    "Rastrata could not tell whether the connection was made. The setup token works once, so it may be spent. If you are still not connected, create a new setup token at the Bridge and try again.",
  connected: "Connected. Now choose which accounts to read.",
  notConnected: "Not connected",
  noBookTitle: "Set up your books first",
  noBook: "The bank connection records to accounts in your chart, and there is no book yet.",
  home: "Go to Home",

  // ---- Connected -------------------------------------------------------------------------------------
  connectedTo: (host: string) => `Connected to ${host}`,
  connectedFacts: "The access URL is saved in a private file beside your book. It is never shown.",
  disconnect: "Disconnect",
  disconnectTitle: "Disconnect the bank connection?",
  disconnectBody:
    "This deletes the saved access URL from this computer. Transactions already imported, your links and how far each account was read are kept, so connecting again with a new setup token carries on. It does not tell the Bridge: to stop the access working there, revoke it in your Bridge account.",
  disconnectKeep: "Keep it connected",
  disconnectDo: "Disconnect",
  disconnecting: "Disconnecting…",
  disconnectFailed: "The bank connection could not be disconnected",
  unusable: "The saved connection cannot be used",

  // ---- Needs you -------------------------------------------------------------------------------------
  attentionTitle: "What needs you",
  attentionNone: "Nothing needs you.",
  bridgeSaid: "What the Bridge said",
  bridgeSaidNote: "The Bridge's own words, shown as text.",
  attentionTitles: {
    credential_unusable: "The saved connection cannot be used",
    credential_missing: "The connection is not saved on this computer",
    access_denied: "The Bridge refused the access",
    payment_required: "The Bridge needs payment",
    rate_limited: "The Bridge asked Rastrata to slow down",
    paused: "Syncing is paused",
    bridge_access: "The Bridge refused the access",
    bridge_connection: "A bank connection needs you",
    bridge_account_failed: "The Bridge could not read an account",
    bridge_missing_data: "The Bridge's answer was incomplete",
    bridge_rate_limit: "The Bridge asked Rastrata to slow down",
    bridge_api: "The Bridge reported a problem",
    bridge_other: "The Bridge reported a problem",
    account_gone: "An account is no longer listed",
    account_error: "An account could not be read",
    transactions_held: "Some transactions were not imported",
    no_links: "Choose which accounts to read",
    unlinked_accounts: "Some accounts are not linked",
    stale: "The connection is out of date",
  } as Readonly<Record<string, string>>,
  attentionFallback: { error: "Needs you", warning: "Needs your attention", info: "Good to know" },

  // ---- Accounts --------------------------------------------------------------------------------------
  accountsTitle: "Accounts",
  accountsIntro:
    "These are the accounts the Bridge lists. Only an account you link is ever read; one that appears at your bank later is shown here as not linked and is left alone until you choose.",
  accountsNone: "The Bridge lists no accounts. Add a bank at the Bridge, then check again.",
  accountsLoading: "Reading the accounts…",
  accountsFailed: "The accounts could not be read. Your books have not been changed.",
  refresh: "Check for accounts",
  refreshing: "Asking the Bridge…",
  refreshNote: "Asking the Bridge for its accounts uses one of its requests for the day.",
  balanceAsOf: (date: string) => `Balance the Bridge reports, as of ${formatDate(date)}`,
  stateLabels: {
    linked: "Linked",
    unlinked: "Not linked, never read",
    unsupported: "Cannot be linked",
    gone: "No longer listed by the Bridge",
  } as Readonly<Record<BankfeedAccountState, string>>,
  bookedTo: "Chart account",
  linkedToUnknown: "Linked to an account that is no longer in the chart",
  readFrom: "Read from",
  readThrough: "Read through",
  notReadYet: "Not read yet",
  lastRead: "Last read",
  feedBalanceTitle: (date: string) => `Balance from the connection as of ${formatDate(date)}`,
  feedReported: "The Bridge's balance",
  feedBooks: "Posted in your books",
  feedWaiting: "Waiting for review",
  feedAside: "Set aside",
  feedDifference: "Not explained",
  feedNotStatement:
    "A balance from the connection is what the Bridge says, not your bank's statement. A reconciliation always asks for the statement's own ending balance.",
  linkAccount: "Chart account",
  chooseAccount: "Choose an account",
  firstDay: "First day to read",
  firstDayHint:
    "Leave it empty to start on your start date, or on the first day of the fiscal year if there is none. Transactions before it are set aside.",
  chooseFirst: "Choose the chart account this one is recorded to.",
  link: "Link this account",
  linking: "Linking…",
  unlink: "Stop reading",
  unlinking: "Stopping…",
  unlinkNote: "Transactions already imported stay.",
  linkFailed: "The account could not be linked",
  unlinkFailed: "The account could not be unlinked",
  foreignTitle: "Another currency",
  foreign: (currency: string, book: string) =>
    `This account is in ${currency} and your book is in ${book}. Rastrata does not convert currencies: its transactions are held for you to review and never recorded on their own.`,
  noChart:
    "No chart account can take a bank connection yet. It is recorded to an open asset or liability account.",

  // ---- Sync ------------------------------------------------------------------------------------------
  syncTitle: "Sync",
  syncIntro:
    "A sync imports new posted transactions of the linked accounts for you to review. Pending transactions are not imported until the bank has posted them.",
  syncNow: "Sync now",
  syncing: "Syncing…",
  syncProgress: (calls: number, transactions: number) =>
    `Working: ${plural(calls, "request batch", "request batches")} so far, ${plural(transactions, "new transaction", "new transactions")}.`,
  syncDone: "The sync finished",
  syncMore: "The sync stopped part-way and carries on next time",
  syncPaused: "The sync is paused",
  syncFailed: "The sync did not finish",
  syncUncertain: "The result of the sync is uncertain",
  syncUncertainBody:
    "The reply was lost. Resuming sends exactly what was sent before, so nothing is read twice.",
  resume: "Resume",
  never: "No sync has run yet.",
  pausedUntil: (when: string) => `Do not ask again before ${formatInstant(when)}.`,
  syncBlockedNotConnected: "Connect the bank first.",
  syncBlockedNoLinks: "Link an account first: nothing is read until you do.",
  syncBlockedPaused: (when: string) =>
    `Paused: the Bridge asked Rastrata to slow down. It carries on after ${formatInstant(when)}.`,
  lastSync: "Last sync",
  trigger: "Started",
  triggers: { manual: "by you", scheduled: "by the daily sync" } as Readonly<
    Record<"manual" | "scheduled", string>
  >,
  newLines: "New transactions",
  alreadyImported: "Already imported",
  pendingLeft: "Pending, left for the bank to post",
  held: "Not read exactly, not imported",
  requestsRun: "Requests this sync",
  notes: "Notes",
  reviewInbox: "Review the transactions",
  requestsLine: (used: number, limit: number, budget: number) =>
    `Requests to the Bridge in the last 24 hours: ${formatCount(used)} of about ${formatCount(limit)}. Rastrata stops at ${formatCount(budget)} so the Bridge never disables the access.`,
  historyTitle: "Earlier syncs",
  historyEmpty: "No earlier syncs.",
  columns: { when: "Started", by: "By", result: "Result", transactions: "New transactions" },
  runResult: (run: Pick<BankfeedRunView, "disposition" | "errorCode">): string => {
    switch (run.disposition) {
      case "complete":
        return "Finished";
      case "more":
        return "Part-way";
      case "paused":
        return "Paused";
      case "running":
        return "Running";
      default:
        return run.errorCode === "bankfeed_unavailable"
          ? "The Bridge could not be reached"
          : run.errorCode === "bankfeed_access_denied"
            ? "The Bridge refused the access"
            : run.errorCode === "bankfeed_interrupted"
              ? "Interrupted"
              : "Failed";
    }
  },

  // ---- Daily sync ------------------------------------------------------------------------------------
  dailyTitle: "Daily sync",
  dailyIntro:
    "Off unless you turn it on. When it is on, the installed Rastrata syncs once a day at the time you choose, with the same request budget as a sync you start yourself. It never posts anything. If a sync fails because the Bridge cannot be reached it tries once more two hours later, and never when the Bridge has refused the access.",
  dailyOn: "Sync once a day by itself",
  dailyAt: "At this time of day",
  dailyAtHint:
    "Your local time. A time that is not on the hour is kinder to the Bridge, which is busiest then.",
  dailySave: "Save",
  dailySaving: "Saving…",
  dailySaved: "Saved.",
  dailyFailed: "The setting could not be saved",
  dailyNotRunningTitle: "Not running in this copy",
  dailyNotRunning:
    "This copy of Rastrata is not running the daily sync, so nothing syncs by itself here. The installed service does. The setting is saved and takes effect where it runs.",

  // ---- Uncertain writes ------------------------------------------------------------------------------
  uncertainTitle: "The result is uncertain",
  uncertainBody:
    "The reply was lost, so Rastrata cannot tell whether this went through. Resuming sends exactly what was sent before; nothing is done twice.",

  tryAgain: "Try again",
  unavailable: "The bank connection is unavailable",
  unavailableBody: "It could not be read. Your books have not been changed.",
  checking: "Checking the bank connection…",
} as const;

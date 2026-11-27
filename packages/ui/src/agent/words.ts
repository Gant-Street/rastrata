/** Every word the Agents components own, in one place, in plain terms: say what happened and what to do
 * next, and never claim an outcome that is not confirmed. Data (names, dates) is never in this file. */
import type { TokenPermission } from "./types";

export const permissionWords: Record<
  TokenPermission,
  { name: string; effect: string; changesBooks: boolean }
> = {
  read: {
    name: "Read",
    effect:
      "See the chart of accounts, transactions, reports and what is waiting for review. Always included.",
    changesBooks: false,
  },
  draft: {
    name: "Draft",
    effect:
      "Save drafts, prepare entries, bring bank and Stripe transactions in for review, categorize them, write rules and start reconciliations. Nothing is posted.",
    changesBooks: false,
  },
  post: {
    name: "Post",
    effect:
      "Post prepared entries and reviewed transactions to the books. Posting is permanent: a mistake is fixed with a reversal, never by editing.",
    changesBooks: true,
  },
  configure: {
    name: "Configure",
    effect:
      "Change how the books are set up: accounts, tags and tax lines, the calendar, where transactions come from, Stripe and classifier settings, and make backups and exports.",
    changesBooks: true,
  },
  correct: {
    name: "Correct",
    effect: "Reverse posted journals.",
    changesBooks: true,
  },
  close: {
    name: "Close",
    effect:
      "Finish or void reconciliations, close and reopen accounting periods and close a fiscal year. An agent with Close does these steps with no review from you first. No choice includes it.",
    changesBooks: true,
  },
};

export const words = {
  title: "Agents",
  intro: "Let Claude Code, Codex or another agent keep these books for you.",

  // 1. What it may do. Each choice is one of the service's presets; none closes a month, and finishing a
  // reconciliation stays with a person.
  choiceTitle: "What may it do?",
  choices: {
    draft: {
      name: "Prepare",
      label: "Prepare, for my approval.",
      detail: "It drafts; nothing is posted until you accept it.",
      ask: "Review this week’s transactions and show me what you would post.",
    },
    "read-only": {
      name: "Read only",
      label: "Read only.",
      detail: "",
      ask: "How did last month go?",
    },
    bookkeeper: {
      name: "Run the books",
      label: "Run the books.",
      detail: "It posts. You reconcile and close.",
      ask: "Do this week’s bookkeeping.",
    },
  },

  // 2. The one command.
  commandTitle: "Run this where your agent works",
  getCommand: "Get the command",
  gettingCommand: "Getting the command…",
  codeOnce: "The code works once, for ten minutes.",
  codeRanOut: "That code ran out.",
  nowConnected: (name: string) => `${name} is connected.`,
  another: "Connect another",
  install: "Install the command line",
  copyCommand: "Copy",
  commandCopied: "Copied",
  commandFailed: "The command could not be made. Try again.",

  // 3. What to say.
  askTitle: "Then ask it",

  // What is connected.
  connectedTitle: "Connected",
  connectedEmpty: "Nothing is connected yet.",
  connectedLoading: "Reading what is connected…",
  connectedFailed: "What is connected could not be read",
  retry: "Try again",
  used: (age: string) => `Used ${age}`,
  notUsed: "Not used yet",
  ends: (date: string) => `Ends ${date}`,
  ended: (date: string) => `Ended ${date}`,
  disconnect: "Disconnect",
  disconnectFor: (name: string) => `Disconnect ${name}`,
  disconnecting: "Disconnecting…",
  changes: "What agents changed",

  // Disconnecting.
  disconnectTitle: (name: string) => `Disconnect ${name}?`,
  disconnectBody: "It stops working within a few minutes. What it did stays in the books.",
  disconnectKeep: "Keep it",
  disconnectConfirm: "Disconnect",
  disconnectFailed: "It could not be disconnected. It is still connected.",
  disconnected: (name: string) => `${name} was disconnected`,
};

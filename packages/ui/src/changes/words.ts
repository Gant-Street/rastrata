/** Every word the Changes components own, in one place, in plain terms: say what happened and what to
 * do next, and never claim an outcome that is not confirmed. Data (the service's sentences, names,
 * dates, amounts) is never in this file. */
import { formatCount } from "../format";
import type { ChangeKindId, MakerKind, SubjectKind } from "./types";
import type { SinceChoice, WhatGroup } from "./url-state";

const many = (count: number, one: string, other: string): string =>
  `${formatCount(count)} ${count === 1 ? one : other}`;

/** The thing a change is about, as a short label on its row. */
export const kindWords: Readonly<Record<ChangeKindId, string>> = {
  "entry.posted": "Entry",
  "entry.reversed": "Entry",
  "period.closed": "Period",
  "period.reopened": "Period",
  "calendar.extended": "Calendar",
  "account.added": "Account",
  "account.changed": "Account",
  "account.closed": "Account",
  "account.tagged": "Account",
  "rule.created": "Rule",
  "rule.changed": "Rule",
  "reconciliation.completed": "Reconciliation",
  "reconciliation.voided": "Reconciliation",
  "access.granted": "Access",
  "access.revoked": "Access",
  "book.opened": "Books",
  "book.changed": "Books",
};

/** What happened, for a screen reader to hear beside the sentence (the sentence says it too). */
export const makerKindWords: Readonly<Record<MakerKind, string>> = {
  owner: "the owner",
  person: "a person",
  agent: "an agent",
  service: "Rastrata",
  unknown: "not recorded",
};

const ROLES: Readonly<Record<string, string>> = {
  owner: "the owner",
  admin: "an admin",
  accountant: "an accountant",
  member: "a member",
};

/** Where a change's own page is, in words: the link on its row. */
export const openWords: Readonly<Record<SubjectKind, string | null>> = {
  journal: "Open entry",
  account: "Open account",
  rule: "Open rules",
  period: "Open the period",
  calendar: "Open the calendar",
  reconciliation: "Open reconciliation",
  token: "Open agents",
  member: "Open members",
  book: null,
};

export const sinceWords: Readonly<Record<SinceChoice, string>> = {
  look: "You last looked",
  close: "The books were last closed",
  week: "7 days ago",
  month: "30 days ago",
  year: "The start of this year",
  all: "The start of the books",
};

export const whatWords: Readonly<Record<"" | WhatGroup, string>> = {
  "": "Everything",
  entries: "Entries",
  periods: "Periods and the calendar",
  accounts: "Accounts",
  rules: "Rules",
  reconciliations: "Reconciliations",
  access: "Who has access",
};

export const words = {
  title: "Changes",
  description: "What changed in your books, who made it and when.",
  help: [
    "Every entry posted or reversed, every period closed or reopened, and every change to an account, a rule, a reconciliation or who has access is listed here, newest first. A change in this list has already happened: you cannot undo it from here, and nothing here asks you to approve it.",
    "Nothing in your books is ever edited or deleted. A mistake is corrected with an entry that reverses it, and the reversal is in this list too.",
    "When you have read the list, mark it as looked at. The next time you open it, only what happened after that is shown.",
  ],

  // The choices above the list
  filtersLabel: "Choose which changes to show",
  since: "Since",
  who: "Who",
  what: "What",
  search: "Search",
  anyone: "Anyone",
  people: "People",
  agents: "Agents",
  clear: "Clear the choices",

  // The summary
  changesShown: (shown: number, all: number): string =>
    shown === all
      ? many(all, "change", "changes")
      : `${formatCount(shown)} of ${many(all, "change", "changes")}`,
  sinceSentence: (since: string): string => `Since ${since}`,
  untilSentence: (until: string): string => `up to ${until}`,
  readAt: (time: string): string => `Read at ${time}`,
  readAgain: "Read again",
  showWhatIsNew: "Show what is new",
  changesNoun: (count: number): string => (count === 1 ? "change" : "changes"),
  updating: "Reading the newest changes…",
  makersLabel: "Who made them",
  you: "you",

  // The rows
  dayToday: "Today",
  dayYesterday: "Yesterday",
  by: {
    you: "By you",
    owner: "By the owner",
    service: "By Rastrata",
    agent: "By the agent",
    unknown: "Who made it was not recorded",
  },
  moreAccounts: (more: number): string => `and ${formatCount(more)} more`,
  accountsLabel: "Accounts",

  // Saying you have looked
  lookButton: "I have looked at these",
  lookSaving: "Saving…",
  lastLook: (when: string, who: string): string =>
    `Last marked as looked at on ${when}, by ${who}.`,
  neverLooked: "No one has marked any change as looked at yet.",
  lookSaved: (time: string): string =>
    `Saved. You looked at everything up to ${time}. Only what is new after that is shown here.`,
  lookUncertain: {
    title: "We could not tell whether this was saved",
    body: "Checking asks again with the same request, so it is recorded once either way.",
    action: "Check",
  },
  lookStale: {
    title: "Someone looked at newer changes",
    body: "While this page was open, newer changes were marked as looked at. Read the list again to see where things are.",
    action: "Read again",
  },
  lookIncomplete: {
    title: "This list cannot be marked as looked at",
    body: "A part of it could not be read, so something may be missing. Someone who can read all of it, such as the owner, can say they have looked.",
  },
  lookDenied: {
    title: "You may not say this",
    body: "Only someone who may close the books can mark changes as looked at. Ask the owner.",
  },
  lookFailed: {
    title: "It was not saved",
    body: "Nothing was recorded. Try again in a moment.",
    action: "Try again",
  },
  whyNot: {
    filtered:
      "You are looking at some of the changes. Clear the choices to say you have looked at all of them.",
    window:
      "This list starts after changes you have not looked at, so it cannot be marked as looked at. Start it at your last look to see them first.",
    partial:
      "A part of this list could not be read, so it cannot be marked as looked at. Someone who can read all of it, such as the owner, can.",
    withheld:
      "A part of this list is shown only to the owner, so it cannot be marked as looked at here. The owner can.",
  },

  // When there is nothing to show
  emptyAfterLook: {
    title: "Nothing has changed since you last looked",
    body: "New changes will be here as they are made.",
    action: "Show all changes",
  },
  emptyFiltered: {
    title: "No change matches these choices",
    body: "Try other words, or clear the choices.",
  },
  emptyWindow: {
    title: "Nothing has changed in this time",
    body: "Choose an earlier start to see more.",
    action: "Show all changes",
  },
  pastEnd: {
    title: "This page is past the end",
    body: "There are fewer changes than that.",
    action: "Go to the first page",
  },
  emptyBook: {
    title: "Nothing has changed yet",
    body: "Entries, accounts, rules and who has access appear here as they are made.",
  },

  // Loading and failing
  loading: "Reading the changes…",
  failedTitle: "The changes could not be read",
  failedBody: "Nothing in your books has changed.",
  retry: "Try again",

  // What the list could not read, and what it leaves out
  unreadTitle: "A part of this list could not be read",
  unreadBody: "This list is not everything. These could not be read:",
  notCoveredTitle: "Not in this list",
  notCoveredIntro: "These are not listed here yet:",
  attribution: {
    from: (when: string): string =>
      `Who made a change is recorded from ${when} on. A change made before then says “not recorded”: that means the books did not keep who made it, not that no one did.`,
    never:
      "The books have not recorded who made any change yet. Every change says “not recorded”: that means the books did not keep who made it, not that no one did.",
  },
  sourcesTitle: "Where this list was read from",
  readAtLabel: "Read at",
  versionLabel: "Version of the books",
  sourceRead: "Read",
  sourceUnread: "Could not be read",
  sourceChanges: (count: number): string => many(count, "change", "changes"),
} as const;

/** The name of a role, for "by an accountant": a role the book does not know is shown as it is. */
export const roleWords = (role: string): string => ROLES[role.toLowerCase()] ?? `a ${role}`;

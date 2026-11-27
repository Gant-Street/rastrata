import { type HomeStartView, homeWords, type MoneyMonthView, type NeedRowView } from "../../src";

const words = homeWords.start;

/** The start of a new book where a bank can be connected, as the web application makes it. */
export const startConnect: HomeStartView = {
  title: words.connect.title,
  text: words.connect.text,
  action: { label: words.connect.action, href: "#banks" },
  alt: { label: words.connect.alt, href: "#import" },
  lines: [
    { id: "mover", ...words.mover, href: "#bring-in" },
    { id: "agent", ...words.agent, href: "#agent" },
  ],
};

/** Where no bank can be connected: the statement file is the one way in. */
export const startStatement: HomeStartView = {
  title: words.statement.title,
  text: words.statement.text,
  action: { label: words.statement.action, href: "#import" },
  lines: startConnect.lines,
};

export const rows = {
  review: {
    id: "review",
    tone: "attention",
    text: "8 transactions to review.",
    verb: "Review",
    href: "#inbox",
  },
  reconcile: {
    id: "reconcile",
    tone: "attention",
    text: "Business checking is ready to check against its March statement.",
    verb: "Reconcile",
    href: "#reconcile",
  },
  close: {
    id: "close",
    tone: "attention",
    text: "5 things stand in the way of closing March 2026.",
    verb: "See what's left",
    href: "#close",
  },
  closeReady: {
    id: "close",
    tone: "attention",
    text: "March 2026 is ready to close.",
    verb: "Close March 2026",
    href: "#periods",
  },
  backup: {
    id: "backup",
    tone: "attention",
    text: "Your books have never been backed up.",
    verb: "Back up now",
    href: "#backups",
  },
  stripe: {
    id: "stripe",
    tone: "problem",
    text: "2 Stripe payouts do not add up.",
    verb: "Look at payouts",
    href: "#stripe",
  },
  bankfeed: {
    id: "bankfeed",
    tone: "attention",
    text: "Your bank connection needs attention.",
    verb: "Fix it",
    href: "#bank",
  },
  calendar: {
    id: "calendar",
    tone: "attention",
    text: "Your calendar ends on Dec 31, 2026.",
    verb: "Extend it",
    href: "#calendar",
  },
  tokens: {
    id: "tokens",
    tone: "attention",
    text: "1 agent stops working within 14 days.",
    verb: "See agents",
    href: "#agent",
  },
} as const satisfies Record<string, NeedRowView>;

const month = (
  key: string,
  name: string,
  short: string,
  income: string | null,
  expenses: string | null,
  note?: string,
): MoneyMonthView => ({ month: key, name, short, income, expenses, note });

export const sixMonths: MoneyMonthView[] = [
  month("2026-05", "May 2026", "May", "6300.00", "2100.00"),
  month("2026-06", "June 2026", "Jun", "7450.00", "3010.55"),
  month("2026-07", "July 2026", "Jul", "5200.00", "4870.20"),
  month("2026-08", "August 2026", "Aug", "8120.00", "2995.40"),
  month("2026-09", "September 2026", "Sep", "9360.00", "3640.00"),
  month("2026-10", "October 2026", "Oct", "4170.00", "2682.44"),
];

export const beforeBooks: MoneyMonthView[] = [
  month("2026-05", "May 2026", "May", null, null, homeWords.money.beforeBooks),
  month("2026-06", "June 2026", "Jun", null, null, homeWords.money.beforeBooks),
  month("2026-07", "July 2026", "Jul", null, null, homeWords.money.beforeBooks),
  month("2026-08", "August 2026", "Aug", "1200.00", "300.00"),
  month("2026-09", "September 2026", "Sep", "0.00", "0.00"),
  month("2026-10", "October 2026", "Oct", "4170.00", "2682.44"),
];

export const oneNotRead: MoneyMonthView[] = sixMonths.map((entry) =>
  entry.month === "2026-07"
    ? month(entry.month, entry.name, entry.short, null, null, homeWords.money.notRead)
    : entry,
);

export const allZero: MoneyMonthView[] = sixMonths.map((entry) =>
  month(entry.month, entry.name, entry.short, "0.00", "0.00"),
);

export const bigNumbers: MoneyMonthView[] = sixMonths.map((entry, index) =>
  month(
    entry.month,
    entry.name,
    entry.short,
    `${(index + 1) * 1234567}.89`,
    `${(index + 1) * 456789}.12`,
  ),
);

/** The question bank: sixty questions in an owner's own words, ten to a session, about the founder's
 * March (Willow Lane Studio, cash basis). Each has an id (`A12`, the name its answer line carries), a
 * group, the kind of answer, and a class that says whether the product can answer it:
 *
 *   now          the scripted right agent answers it with commands that exist today
 *   after:<lane> it cannot yet; the lane named would let it (`none`: no planned lane does)
 *   unsupported  Rastrata does not do this; the right answer is to say so
 *
 * The class of each question was decided by running the real commands against a seeded book, not by
 * reading the product's documents: `recipes.ts` holds the commands for every `now` question, and an
 * `after:` question says what is missing and what the closest read gives today. The expected answers
 * are in `oracle.ts`. Every question names its period (March 2026) or its date, because the service's
 * clock is not the book's: "this month" would be October.
 *
 * The wording is ours. It follows the topics an owner brings to a bookkeeper, and it never contains
 * its own answer. */
import type { AskedKind, Group, Lane, Question } from "./types.ts";

type Kind = Exclude<Question["kind"], "unsupported">;

const session = (number: number): number => Math.ceil(number / 10);

/** A question the right agent answers today. */
const now = (number: number, group: Group, kind: Kind, text: string): Question => ({
  id: `A${number}`,
  number,
  session: session(number),
  group,
  text,
  kind,
  class: "now",
});

/** A question a lane would make answerable: what is missing, and what the closest read gives today. */
const after = (
  number: number,
  lane: Lane,
  group: Group,
  kind: Kind,
  text: string,
  needs: string,
): Question => ({
  id: `A${number}`,
  number,
  session: session(number),
  group,
  text,
  kind,
  class: `after:${lane}`,
  needs,
});

/** A question about something Rastrata does not do: the right answer is to say so. */
const unsupported = (
  number: number,
  group: Group,
  asks: AskedKind,
  text: string,
  reason: string,
): Question => ({
  id: `A${number}`,
  number,
  session: session(number),
  group,
  text,
  kind: "unsupported",
  asks,
  class: "unsupported",
  reason,
});

export const QUESTIONS: readonly Question[] = [
  // ----- session 1: how the month went, and the first balances -----------------------------------
  now(
    1,
    "profit-and-loss",
    "money",
    "What was my net income for March? If I lost money, give it as a negative number.",
  ),
  now(2, "profit-and-loss", "money", "What was my total income for March?"),
  now(3, "profit-and-loss", "money", "What were my total expenses for March?"),
  now(4, "profit-and-loss", "money", "How much did I spend on advertising in March?"),
  now(
    5,
    "profit-and-loss",
    "money",
    "How much did I spend on software and subscriptions in March?",
  ),
  now(6, "profit-and-loss", "name", "Which kind of expense cost me the most in March?"),
  now(
    7,
    "balances-and-cash",
    "money",
    "How much money is in my Chase business checking account as of March 31?",
  ),
  now(
    8,
    "balances-and-cash",
    "money",
    "How much do I owe on my Amex business card as of March 31?",
  ),
  now(9, "balances-and-cash", "money", "What were my total assets at the end of March?"),
  unsupported(
    10,
    "profit-and-loss",
    "money",
    "How much of my March advertising budget have I used so far?",
    "Rastrata keeps no budgets, so there is nothing to measure spending against.",
  ),

  // ----- session 2: balances, cash and Stripe ------------------------------------------------------
  now(
    11,
    "balances-and-cash",
    "money",
    "How much money was in my Rho business checking account at the end of March?",
  ),
  now(
    12,
    "balances-and-cash",
    "money",
    "How much money was in my Chase business checking account at the end of the day on March 15?",
  ),
  now(13, "balances-and-cash", "money", "What was my total equity at the end of March?"),
  now(
    14,
    "balances-and-cash",
    "money",
    "According to my cash flow statement, how much did my cash change over March? Give a decrease as a negative number.",
  ),
  now(
    15,
    "balances-and-cash",
    "money",
    "What did my books show in the account called Stripe payouts in transit at the end of March?",
  ),
  unsupported(
    16,
    "money-out",
    "list",
    "Which bills do I have to pay next week, and how much is each one?",
    "Rastrata keeps no bills or payables: a payment is booked when it leaves the bank.",
  ),
  now(17, "money-in", "money", "How much did Stripe charge me in fees in March?"),
  now(
    18,
    "money-in",
    "count",
    "How many Stripe payouts reached my bank in March? Do not count a payout that failed.",
  ),
  now(19, "money-in", "money", "How much was my biggest Stripe payout in March?"),
  unsupported(
    20,
    "balances-and-cash",
    "count",
    "How many units of my best-selling product do I have in stock at the end of March?",
    "Rastrata keeps no inventory items or quantities.",
  ),

  // ----- session 3: money in ------------------------------------------------------------------------
  now(21, "money-in", "money", "How much did I refund to customers in March?"),
  after(
    22,
    "payees",
    "taxes",
    "count",
    "How many of the people I paid in 2026 have been paid $2,000 or more?",
    "A total for each payee under every spelling its bank text takes, to hold against the 1099 threshold (money by payee, once the payees are named). Today the 1099 list counts only the expense accounts the owner has marked and says so (no_accounts_marked), so its zero means nothing is counted. The payees report groups texts that differ only in digits and totals the words an agent chooses, but a payee whose spellings differ in more than digits (FACEBK *ADS 1Q2W3E, FACEBK *ADS 2R3T4Y) is several rows until the owner names it, so an agent that cannot name payees has to reason about the groups.",
  ),
  unsupported(
    23,
    "money-in",
    "name",
    "Which product sold the most units in March?",
    "Rastrata books Stripe at payout level and keeps no products or units.",
  ),
  now(24, "money-in", "date", "On what date did my biggest Stripe payout in March arrive?"),
  now(25, "money-in", "money", "How much did Northwind LLC pay me in March?"),
  now(26, "money-in", "name", "Which customer paid me the most in March?"),
  // A27 and A28 were `after:percent` until the profit and loss could show a share of income
  // (`rastrata reports profit-loss --share income`): a division and a rounding that the runbook tells
  // an agent never to do itself.
  now(
    27,
    "profit-and-loss",
    "percent",
    "What share of my March income went to advertising? Give a percentage with one decimal.",
  ),
  now(
    28,
    "profit-and-loss",
    "percent",
    "What was my net income as a percentage of my March income? Use a negative number for a loss.",
  ),
  now(29, "money-in", "money", "How much interest did my bank accounts pay me in March?"),
  unsupported(
    30,
    "money-in",
    "list",
    "Which of my customers are more than 30 days late paying me, and how much does each owe?",
    "Rastrata keeps no invoices or receivables: a customer's payment is booked when it arrives.",
  ),

  // ----- session 4: money out and payees ---------------------------------------------------------
  now(31, "money-out", "money", "How much rent did I pay in March?"),
  now(32, "money-out", "count", "How many times was I charged for Adobe Creative Cloud in March?"),
  now(33, "money-out", "money", "How much did I spend on Adobe Creative Cloud in March in total?"),
  now(
    34,
    "money-out",
    "money",
    "How much did I spend on Uber in March, after the credit I got back?",
  ),
  now(35, "money-out", "money", "How much did I pay ATX Accounting PLLC in March?"),
  // (Asked before `reports largest` existed, A36 was `after:none`: no read ranked entries, so an agent paged all 91 and compared for
  // itself, and in the second measurement it left the rent out and answered with the check.)
  now(36, "money-out", "money", "What was the largest single expense I recorded in March?"),
  now(
    37,
    "money-out",
    "count",
    "How many transactions are sitting in my Other expenses account for March?",
  ),
  now(
    38,
    "money-out",
    "list",
    "Which expense accounts cost me more than $800 in March? List their names separated by semicolons.",
  ),
  unsupported(
    39,
    "money-out",
    "money",
    "How much did I withhold from my employee's paycheck for social security in March?",
    "Rastrata keeps no payroll records: a payroll journal can be imported, but withholdings are not reported.",
  ),
  unsupported(
    40,
    "money-out",
    "count",
    "How many miles did I drive for the business in March?",
    "Rastrata keeps no mileage or time records.",
  ),

  // ----- session 5: the bank, reconciling and closing ----------------------------------------------
  now(
    41,
    "bank-and-reconciliation",
    "money",
    "My Chase statement for March ends at 11,125.71. How much higher is the Chase balance in my books than the statement?",
  ),
  now(
    42,
    "bank-and-reconciliation",
    "name",
    "Which transaction on my Chase statement is missing from my books?",
  ),
  now(
    43,
    "bank-and-reconciliation",
    "count",
    "How many statement lines are set aside (not booked), for any reason, across my bank and card accounts?",
  ),
  now(
    44,
    "bank-and-reconciliation",
    "count",
    "How many statement lines are still waiting for me to review?",
  ),
  now(
    45,
    "bank-and-reconciliation",
    "count",
    "How many of my bank and card accounts have been reconciled to a statement so far?",
  ),
  now(
    46,
    "closing-and-checks",
    "count",
    "How many things does the checklist say stand in the way of closing March?",
  ),
  now(47, "closing-and-checks", "name", "Is the March period open or closed?"),
  now(48, "chart-and-setup", "date", "What is my cutover date, the day my books start counting?"),
  now(49, "chart-and-setup", "name", "Are my books kept on the cash basis or the accrual basis?"),
  unsupported(
    50,
    "closing-and-checks",
    "count",
    "How many estimates have I sent to customers that they have not accepted yet?",
    "Rastrata makes no estimates or quotes: it books money that moved.",
  ),

  // ----- session 6: tax, history and setup ------------------------------------------------------------
  now(51, "taxes", "money", "How much sales tax do my books show I collected in March?"),
  now(
    52,
    "taxes",
    "money",
    "What net profit or loss does my Schedule C worksheet show for 2026? Give a loss as a negative number.",
  ),
  now(
    53,
    "taxes",
    "money",
    "What does my Schedule C worksheet for 2026 show on the business meals line?",
  ),
  now(54, "history", "name", "Which of my rules was written by an agent instead of by me?"),
  now(55, "history", "count", "How many entries in my books did an agent post in March?"),
  now(
    56,
    "history",
    "name",
    "Who posted the March rent entry that I wrote by hand: me or an agent?",
  ),
  // The catch-all lane's role key: asked before it landed, this was `after:catchall` (the chart carried
  // tax lines and cash-flow classes and no such role, so an agent could only guess that Other expenses
  // was meant).
  now(
    57,
    "chart-and-setup",
    "name",
    "Which account does my book treat as the catch-all for expenses?",
  ),
  now(
    58,
    "history",
    "name",
    "Which account did I add to my chart after the book was first set up?",
  ),
  unsupported(
    59,
    "taxes",
    "money",
    "How much federal income tax do I owe on my March profit?",
    "Rastrata books and reports; it does not work out what anyone owes or give tax advice.",
  ),
  unsupported(
    60,
    "profit-and-loss",
    "money",
    "What do you expect my net income to be for April?",
    "Rastrata books and reports what happened; it does not predict.",
  ),
];

export const SESSIONS = 6;

export const questionById = (id: string): Question => {
  const found = QUESTIONS.find((question) => question.id === id);
  if (!found) throw new Error(`Unknown question ${id}`);
  return found;
};

/** The ten questions a session asks, in order. */
export const questionsOfSession = (number: number): readonly Question[] =>
  QUESTIONS.filter((question) => question.session === number);

/** What the format hint after an id says the answer should look like. An unsupported question is
 * shown as the kind a supported one would be, so the hint never gives it away. */
export const HINTS: Readonly<Record<AskedKind, string>> = {
  money: "an amount",
  percent: "a percentage",
  count: "a whole number",
  date: "a date",
  name: "a name",
  list: "a list",
};

export const hintOf = (question: Question): string =>
  HINTS[question.kind === "unsupported" ? (question.asks ?? "name") : question.kind];

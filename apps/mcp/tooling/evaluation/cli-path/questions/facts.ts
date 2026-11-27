/** The founder's March as dated postings, built from the world's rows in integer cents and from nothing
 * the application says. The question oracle reads every figure from here.
 *
 * It is the acceptance test's own booking rule (`expectedLedger` in the fixtures) written again with a
 * date on every posting, so a figure can be asked for at any day and for any range. A test holds the
 * two to each other: this model's ledger at the end of March equals `expectedLedger`, account by
 * account.
 *
 * What is booked is what the owner's `month-posted` stage books: every settled line after the cutover
 * is posted, the one personal line is set aside (the owner decides what it is), a payment the owner
 * wrote by hand is a posting on its own date, and each Stripe payout is one entry on its arrival date. */
import {
  CUTOVER,
  cents,
  dec,
  openingLedger,
} from "@rastrata/application/testing/evaluation-fixtures";
import type { Row } from "@rastrata/application/testing/evaluation-fixtures";
import type { LineExpectation, World } from "../world.ts";

/** One side of an entry: debit-positive cents on an account on a day. */
export interface Posting {
  readonly date: string;
  readonly account: string;
  readonly cents: bigint;
  /** What the bank printed (description and counterparty), upper case as the statements carry it. */
  readonly text: string;
  /** The entry it belongs to, so a transfer's two sides and a payout's legs can be told apart. */
  readonly entry: string;
}

export const MARCH = { from: "2026-03-01", to: "2026-03-31" } as const;

/** The day before the cutover: the opening entry is dated then. */
export const OPENING_DATE = ((): string => {
  const day = new Date(`${CUTOVER}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
})();

const textOf = (row: Row): string => [row.memo, row.party ?? ""].join(" ").trim().toUpperCase();

export interface Facts {
  readonly postings: readonly Posting[];
  /** The lines the owner booked, with the statements' own text (not the personal line). */
  readonly booked: readonly LineExpectation[];
  /** The line the owner set aside as personal. */
  readonly setAside: LineExpectation | undefined;
  /** Debit-positive balance of an account at the end of a day. */
  balance(account: string, asOf?: string): bigint;
  /** What an account moved in a range, debit-positive. */
  movement(account: string, from: string, to: string): bigint;
  /** The postings of an account in a range, oldest first. */
  activity(account: string, from: string, to: string): readonly Posting[];
  /** Profit and loss over a range, from the postings on income and expense accounts. */
  profitLoss(from: string, to: string): ProfitLoss;
  /** Booked lines whose statement text contains the words, case-insensitively. */
  linesWith(words: string): readonly LineExpectation[];
}

export interface ProfitLoss {
  /** Income accounts, credit-normal (a refund account shows negative). */
  readonly income: ReadonlyMap<string, bigint>;
  /** Expense accounts, debit-normal. */
  readonly expenses: ReadonlyMap<string, bigint>;
  readonly totalIncome: bigint;
  readonly totalExpenses: bigint;
  readonly netIncome: bigint;
}

const sum = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const value of values) total += value;
  return total;
};

export function buildFacts(world: World): Facts {
  const postings: Posting[] = [];
  const add = (entry: string, date: string, account: string, value: bigint, text: string) => {
    if (value !== 0n) postings.push({ date, account, cents: value, text, entry });
  };

  // The opening entry, dated the day before the cutover.
  for (const [account, value] of openingLedger())
    add("opening", OPENING_DATE, account, value, "OPENING BALANCES");

  // The lines: each settled line after the cutover, except the one the owner set aside.
  const setAside = world.lines.find((line) => "personal" in line.row.dest);
  const booked = world.lines.filter((line) => line.kind === "booked" && line !== setAside);
  for (const line of booked) {
    const { row } = line;
    const amount = cents(row.amount);
    const entry = line.id;
    const text = textOf(row);
    add(entry, row.date, line.account, amount, text);
    const dest = row.dest;
    if ("to" in dest) add(entry, row.date, dest.to, -amount, text);
    else if ("split" in dest)
      for (const [code, part] of dest.split)
        add(entry, row.date, code, amount < 0n ? cents(part) : -cents(part), text);
    else if ("payout" in dest) add(entry, row.date, "1110", -amount, text);
    // A transfer's other side is a line of its own; a payment entered by hand is the same two
    // postings, made earlier by the owner.
  }

  // Each payout is one entry on the day it arrives, its legs as the booking rule gives them.
  for (const payout of world.payouts)
    for (const [account, value] of payout.legs)
      add(`stripe:${payout.label}`, payout.arrival, account, value, `STRIPE PAYOUT ${payout.id}`);

  const balance = (account: string, asOf = MARCH.to): bigint =>
    sum(
      postings
        .filter((posting) => posting.account === account && posting.date <= asOf)
        .map((posting) => posting.cents),
    );
  const activity = (account: string, from: string, to: string): readonly Posting[] =>
    postings
      .filter(
        (posting) => posting.account === account && posting.date >= from && posting.date <= to,
      )
      .sort((a, b) => a.date.localeCompare(b.date));
  const movement = (account: string, from: string, to: string): bigint =>
    sum(activity(account, from, to).map((posting) => posting.cents));

  const profitLoss = (from: string, to: string): ProfitLoss => {
    const income = new Map<string, bigint>();
    const expenses = new Map<string, bigint>();
    for (const account of new Set(postings.map((posting) => posting.account))) {
      const moved = movement(account, from, to);
      if (moved === 0n) continue;
      if (account.startsWith("4")) income.set(account, -moved);
      else if (account.startsWith("5") || account.startsWith("6")) expenses.set(account, moved);
    }
    const totalIncome = sum(income.values());
    const totalExpenses = sum(expenses.values());
    return { income, expenses, totalIncome, totalExpenses, netIncome: totalIncome - totalExpenses };
  };

  const linesWith = (words: string): readonly LineExpectation[] => {
    const needle = words.toUpperCase();
    return booked.filter((line) => textOf(line.row).includes(needle));
  };

  return { postings, booked, setAside, balance, movement, activity, profitLoss, linesWith };
}

/** Money as the wire writes it, for messages. */
export const money = (value: bigint): string => dec(value);

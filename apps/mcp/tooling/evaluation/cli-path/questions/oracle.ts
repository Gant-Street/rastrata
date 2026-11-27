/** The oracle: the right answer to every question, computed from the world's rows in integer cents
 * (`facts.ts`) and never from a report, an operation or a number the application returned. A test that
 * checks a report against the same report would prove nothing; the scripted right agent is what holds
 * this oracle to the real service, question by question.
 *
 * Money is cents in a `bigint`; a share of income is tenths of a percent, worked from integers and
 * rounded half away from zero, never a float. Names that come from the product's chart or setup (an
 * account's name, the book's basis) are written here as constants and are checked against the real
 * book by the end-to-end test: if the product renames one, that test fails and says which. */
import {
  CASH_CODES,
  CUTOVER,
  cents,
  closing,
  dec,
} from "@rastrata/application/testing/evaluation-fixtures";
import { OWNER_RULES } from "../seed.ts";
import { type LineExpectation, type World, buildWorld } from "../world.ts";
import { type Facts, MARCH, OPENING_DATE, buildFacts } from "./facts.ts";
import type { Expected } from "./types.ts";

// ----- exact arithmetic ----------------------------------------------------------------------------

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

/** `amount / total` as tenths of a percent, rounded half away from zero, from integers.
 *
 * This is the percent lane's rule and the oracle keeps its own copy on purpose, so that the report is
 * held to a figure it did not make. A tie goes away from zero on both sides (0.25% is 0.3 and -0.25% is
 * -0.3); the lane's charter wins if the two ever disagree, and `questions-units.test.ts` compares this
 * with the application's over every tie of a grid so they cannot drift apart unseen. */
export function shareTenths(amount: bigint, total: bigint): bigint {
  if (total <= 0n) throw new Error("There is no income to take a share of");
  const scaled = amount * 1000n;
  let quotient = scaled / total;
  const remainder = abs(scaled % total);
  if (2n * remainder >= total) quotient += scaled < 0n ? -1n : 1n;
  return quotient;
}

/** Half of an amount, rounded half away from zero: how the Schedule C worksheet takes 50% of meals. */
export const half = (value: bigint): bigint => {
  const quotient = value / 2n;
  const remainder = abs(value % 2n);
  return remainder === 0n ? quotient : value < 0n ? quotient - 1n : quotient + 1n;
};

const sum = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const value of values) total += value;
  return total;
};

/** The entry of the pairs with the largest value; the first of equals. */
function largest<T>(pairs: Iterable<readonly [T, bigint]>): readonly [T, bigint] {
  let best: readonly [T, bigint] | undefined;
  for (const pair of pairs) if (best === undefined || pair[1] > best[1]) best = pair;
  if (best === undefined) throw new Error("There is nothing to rank");
  return best;
}

// ----- names the product's chart and setup carry --------------------------------------------------------

/** The accounts of the founder's chart that questions name, as the Schedule C template and the
 * founder's own renames call them. Each entry is the canonical name first, then what else an agent may
 * reasonably call it. */
const ACCOUNT_NAMES: Readonly<Record<string, readonly string[]>> = {
  "6000": ["Advertising and marketing", "Advertising"],
  "6025": ["Stripe fees"],
  "6026": ["Chargebacks and disputes"],
  "6030": ["Contract labor", "Contract labour"],
  "6080": ["Legal and professional services"],
  "6120": ["Rent or lease: Office space", "Rent"],
  "6140": ["Supplies"],
  "6160": ["Travel"],
  "6170": ["Meals"],
  "6200": ["Software and subscriptions"],
  "6210": ["Bank and card fees"],
  "6290": ["Other expenses"],
  "6295": ["Other Stripe adjustments"],
};

/** Every name an agent may give an account: those above, and its code (so "6290 Other expenses" and
 * "6290" are the account). */
const nameOf = (code: string): readonly string[] => {
  const names = ACCOUNT_NAMES[code];
  if (!names) throw new Error(`The oracle has no name for account ${code}`);
  return [...names, code];
};

// ----- reading the rows ---------------------------------------------------------------------------------

const amountOf = (line: LineExpectation): bigint => cents(line.row.amount);
const textOfLine = (line: LineExpectation): string =>
  [line.row.memo, line.row.party ?? ""].join(" ").trim().toUpperCase();

const monthPL = (facts: Facts) => facts.profitLoss(MARCH.from, MARCH.to);
const expense = (facts: Facts, code: string): bigint => monthPL(facts).expenses.get(code) ?? 0n;

/** Debit-positive balance of every account whose code starts with the digit, at a day. */
const classBalance = (facts: Facts, digit: string, asOf: string = MARCH.to): bigint =>
  sum(
    [...new Set(facts.postings.map((posting) => posting.account))]
      .filter((account) => account.startsWith(digit))
      .map((account) => facts.balance(account, asOf)),
  );

const cashBalance = (facts: Facts, asOf: string): bigint =>
  sum(CASH_CODES.map((code) => facts.balance(code, asOf)));

/** Who a customer is, from the text of a payment into the bank: the bank writes "ZELLE PAYMENT FROM
 * ACME DESIGN LLC" and "ACH CREDIT NORTHWIND LLC INV 2217". */
const customerOf = (text: string): string | undefined => {
  const zelle = /^ZELLE PAYMENT FROM (.+)$/.exec(text);
  if (zelle?.[1]) return zelle[1].trim();
  const ach = /^ACH CREDIT (.+?) INV \d+/.exec(text);
  return ach?.[1]?.trim();
};

/** The people and businesses paid, grouped as coarsely as can be (the first two words of the bank's
 * text, digits and symbols dropped). Used to say how many were paid $2,000 or more however they are
 * grouped: transfers, payouts and the owner's draw are not payees. */
export function payeeTotals(facts: Facts): ReadonlyMap<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const line of facts.booked) {
    const amount = amountOf(line);
    if (amount >= 0n || !("to" in line.row.dest || "split" in line.row.dest)) continue;
    const key = textOfLine(line)
      .replace(/[^A-Z ]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join(" ");
    totals.set(key, (totals.get(key) ?? 0n) - amount);
  }
  return totals;
}

const statementClosing = (world: World, key: "chase" | "rho" | "card"): bigint => {
  const file = world.files.find((candidate) => candidate.key === key);
  if (!file) throw new Error(`The world has no ${key} statement`);
  return closing(file.rows, file.account as "1000" | "1010" | "2000");
};

const biggestPayout = (world: World) => {
  const [best] = largest(world.payouts.map((payout) => [payout, payout.amount] as const));
  return best;
};

// ----- the answers -----------------------------------------------------------------------------------

const money = (value: bigint): Expected => ({ kind: "money", cents: value });
const count = (value: number): Expected => ({ kind: "count", value });
const name = (...names: string[]): Expected => ({ kind: "name", names });
const UNSUPPORTED: Expected = { kind: "unsupported" };

type Compute = (facts: Facts, world: World) => Expected;

/** The answer to each question, by id. The bank and this table must have the same ids (a test). */
const COMPUTE: Readonly<Record<string, Compute>> = {
  // ----- session 1
  A1: (f) => money(monthPL(f).netIncome),
  A2: (f) => money(monthPL(f).totalIncome),
  A3: (f) => money(monthPL(f).totalExpenses),
  A4: (f) => money(expense(f, "6000")),
  A5: (f) => money(expense(f, "6200")),
  A6: (f) => name(...nameOf(largest(monthPL(f).expenses)[0])),
  A7: (f) => money(f.balance("1000")),
  A8: (f) => money(-f.balance("2000")),
  A9: (f) => money(classBalance(f, "1")),
  A10: () => UNSUPPORTED,
  // ----- session 2
  A11: (f) => money(f.balance("1010")),
  A12: (f) => money(f.balance("1000", "2026-03-15")),
  A13: (f) => money(classBalance(f, "1") + classBalance(f, "2")),
  A14: (f) => money(cashBalance(f, MARCH.to) - cashBalance(f, OPENING_DATE)),
  A15: (f) => money(f.balance("1110")),
  A16: () => UNSUPPORTED,
  A17: (f) => money(expense(f, "6025")),
  A18: (_f, world) =>
    count(
      world.lines.filter(
        (line) => line.kind === "booked" && line.file === "rho" && "payout" in line.row.dest,
      ).length,
    ),
  A19: (_f, world) => money(biggestPayout(world)?.amount ?? 0n),
  A20: () => UNSUPPORTED,
  // ----- session 3
  A21: (f) => money(f.movement("4100", MARCH.from, MARCH.to)),
  A22: (f) => count([...payeeTotals(f).values()].filter((total) => total >= 200_000n).length),
  A23: () => UNSUPPORTED,
  A24: (_f, world) => ({ kind: "date", iso: biggestPayout(world)?.arrival ?? "" }),
  A25: (f) => money(sum(f.linesWith("NORTHWIND LLC").map(amountOf))),
  A26: (f) => {
    const totals = new Map<string, bigint>();
    for (const line of f.booked) {
      if (!("to" in line.row.dest) || line.row.dest.to !== "4000") continue;
      const customer = customerOf(textOfLine(line));
      if (customer) totals.set(customer, (totals.get(customer) ?? 0n) + amountOf(line));
    }
    const [top] = largest(totals);
    return top === "NORTHWIND LLC" ? name("Northwind LLC", "Northwind") : name(top);
  },
  A27: (f) => ({
    kind: "percent",
    tenths: shareTenths(expense(f, "6000"), monthPL(f).totalIncome),
  }),
  A28: (f) => ({
    kind: "percent",
    tenths: shareTenths(monthPL(f).netIncome, monthPL(f).totalIncome),
  }),
  A29: (f) => money(monthPL(f).income.get("4900") ?? 0n),
  A30: () => UNSUPPORTED,
  // ----- session 4
  A31: (f) => money(expense(f, "6120")),
  A32: (f) => count(f.linesWith("ADOBE").length),
  A33: (f) => money(-sum(f.linesWith("ADOBE").map(amountOf))),
  A34: (f) => money(-sum(f.linesWith("UBER").map(amountOf))),
  A35: (f) => {
    const lines = f.linesWith("ATX ACCOUNTING");
    if (lines.length !== 1) throw new Error("ATX Accounting is meant to be paid once");
    return money(-sum(lines.map(amountOf)));
  },
  A36: (f) =>
    money(
      largest(
        f.postings
          .filter((posting) => /^[56]/.test(posting.account) && posting.cents > 0n)
          .map((posting) => [posting, posting.cents] as const),
      )[1],
    ),
  A37: (f) => count(f.activity("6290", MARCH.from, MARCH.to).length),
  A38: (f) => ({
    kind: "list",
    ordered: false,
    items: [...monthPL(f).expenses]
      .filter(([, total]) => total > 80_000n)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code]) => nameOf(code)),
  }),
  A39: () => UNSUPPORTED,
  A40: () => UNSUPPORTED,
  // ----- session 5
  A41: (f, world) => money(f.balance("1000") - statementClosing(world, "chase")),
  A42: (f) => {
    const line = f.setAside;
    if (!line) throw new Error("The world has no line set aside");
    return name(line.row.memo, "Netflix", "Netflix.com");
  },
  A43: (_f, world) =>
    count(world.lines.filter((line) => line.kind === "before-cutover").length + 1),
  A44: () => count(0),
  A45: () => count(0),
  A46: (_f, world) => count(world.files.length),
  A47: () => name("open"),
  A48: () => ({ kind: "date", iso: CUTOVER }),
  A49: () => name("cash", "cash basis"),
  A50: () => UNSUPPORTED,
  // ----- session 6
  A51: (f) => money(-f.movement("2500", MARCH.from, MARCH.to)),
  A52: (f) => money(monthPL(f).netIncome + (expense(f, "6170") - half(expense(f, "6170")))),
  A53: (f) => money(half(expense(f, "6170"))),
  A54: () => {
    const rule = OWNER_RULES.find((candidate) => candidate.agent);
    if (!rule) throw new Error("The seeded book has no rule an agent wrote");
    return name(rule.name, `${rule.name} rule`);
  },
  A55: () => count(0),
  A56: () => name("owner", "me", "you", "the owner"),
  A57: () => name(...nameOf("6290")),
  A58: () => name(...nameOf("6295")),
  A59: () => UNSUPPORTED,
  A60: () => UNSUPPORTED,
};

/** The ids the oracle answers: the bank must ask exactly these. */
export const ORACLE_IDS: readonly string[] = Object.keys(COMPUTE);

/** Every expected answer, computed once for a world (the founder's by default). */
export function expectedAnswers(world: World = buildWorld()): ReadonlyMap<string, Expected> {
  const facts = buildFacts(world);
  return new Map(Object.entries(COMPUTE).map(([id, compute]) => [id, compute(facts, world)]));
}

/** An expected answer as a person would write it (for messages and the results table). */
export function describeExpected(expected: Expected): string {
  switch (expected.kind) {
    case "money":
      return dec(expected.cents);
    case "percent": {
      const sign = expected.tenths < 0n ? "-" : "";
      const magnitude = abs(expected.tenths);
      return `${sign}${magnitude / 10n}.${magnitude % 10n}`;
    }
    case "count":
      return String(expected.value);
    case "date":
      return expected.iso;
    case "name":
      return expected.names[0] ?? "";
    case "list":
      return expected.items.map((item) => item[0] ?? "").join("; ");
    case "unsupported":
      return "UNSUPPORTED";
  }
}

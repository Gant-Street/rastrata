/** The first step of the payees lane, and the rule that holds for good: the places a journal can end
 * up (a payee's row, an unnamed group, an ambiguous group, "no payee") add up to the profit and loss
 * to the cent, for any range, with and without a payee named.
 *
 * The acceptance month's book is the proof on a book with every kind of entry in it (Inbox lines in
 * three statements, a split, an entry written by hand and matched to its line, six Stripe payouts with
 * their fees and refunds, a transfer, a refund from a vendor), and the expected figures are the
 * acceptance test's own oracle (`month.ts`), summed from the rows with integer cents, not the
 * application's reports read back. A property test then asks the same of random books with reversals,
 * supersessions and backdated entries. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { compileCoreReports } from "../src/reports.ts";
import {
  type JournalText,
  type PayeeRecord,
  compilePayeeTotals,
  monthsOf,
} from "../src/payees/totals.ts";
import { payeeKey } from "../src/payees/match.ts";
import { allItems } from "./acceptance/drive.ts";
import {
  CARD,
  CHASE,
  cents,
  dec,
  expectedLedger,
  payoutEntries,
  profitLoss,
} from "./acceptance/month.ts";
import type { World } from "./acceptance/world.ts";
import { bookTheMonth, type MonthBook } from "./payees-support.ts";
import { playRandomBook } from "./support/random-book.ts";
import { sequence } from "./support/kernel-book.ts";

const payee = (id: string, name: string, ...words: string[]): PayeeRecord => ({
  id,
  name,
  words: words.map(payeeKey),
  retired: false,
});

/** What the Inbox says about each journal, read the way the service reads it. */
async function textsOf(world: World): Promise<Map<string, JournalText>> {
  const texts = new Map<string, JournalText>();
  for (const item of await allItems(world, { status: ["posted"], covered: false }))
    if (item.journalId)
      texts.set(
        item.journalId,
        item.line.kind === "event"
          ? { counterparty: "", description: "", connector: "Stripe" }
          : { counterparty: item.line.counterparty ?? "", description: item.line.description },
      );
  return texts;
}

async function stateOf(world: World) {
  return (await world.service.readAggregate()).aggregate.state;
}

describe("the acceptance month's book, by payee", () => {
  let month: (MonthBook & { world: World }) | undefined;
  beforeAll(async () => {
    month = await bookTheMonth();
  });
  afterAll(async () => {
    await month?.world.close();
  });
  const book = async () => month as MonthBook & { world: World };

  /** What the acceptance oracle says the profit and loss is for the whole month. */
  const oracle = (m: MonthBook & { world: World }) => {
    const files = { chase: CHASE, rho: m.rho, card: CARD };
    const personal = new Set(m.rows.filter(({ row }) => "personal" in row.dest).map((r) => r.row));
    return profitLoss(expectedLedger(files, payoutEntries(m.world.scenario), personal));
  };

  test("with nobody named, the unnamed groups and the entries by hand add up to the oracle's profit and loss", async () => {
    const m = await book();
    const state = await stateOf(m.world);
    const texts = await textsOf(m.world);
    for (const range of [
      { from: "2026-03-01", to: "2026-03-31" },
      { from: "2026-01-01", to: "2026-12-31" },
    ]) {
      const report = compilePayeeTotals({ state, ...range, payees: [], texts });
      const expected = oracle(m);
      expect(report.profitLoss.income).toBe(expected.totalRevenue);
      expect(report.profitLoss.expenses).toBe(expected.totalExpenses);
      expect(report.rows).toEqual([]);
      expect(report.ambiguous).toEqual([]);
      expect(report.totals.received).toBe(expected.totalRevenue);
      expect(report.totals.spent).toBe(expected.totalExpenses);
      const unnamedReceived = report.unnamed.reduce((sum, group) => sum + group.received, 0n);
      const unnamedSpent = report.unnamed.reduce((sum, group) => sum + group.spent, 0n);
      expect(
        unnamedReceived + report.noPayee.byHand.received + report.noPayee.noBankText.received,
      ).toBe(expected.totalRevenue);
      expect(unnamedSpent + report.noPayee.byHand.spent + report.noPayee.noBankText.spent).toBe(
        expected.totalExpenses,
      );
    }
  });

  test("digits make one group: the three Chipotle lines are one unnamed payee, and Stripe is one", async () => {
    const m = await book();
    const report = compilePayeeTotals({
      state: await stateOf(m.world),
      from: "2026-03-01",
      to: "2026-03-31",
      payees: [],
      texts: await textsOf(m.world),
    });
    const chipotle = report.unnamed.filter((group) => group.key.startsWith("chipotle"));
    expect(chipotle).toHaveLength(1);
    expect(chipotle[0]).toMatchObject({
      transactions: 4,
      spent: cents("18.45") + cents("16.85") + cents("21.10") + cents("19.60"),
    });
    // A journal a connector made takes the provider's name, so the payouts and their fees are one group.
    const stripe = report.unnamed.find((group) => group.key === "stripe");
    expect(stripe).toMatchObject({ text: "Stripe", transactions: 6 });
    // The rent, written by hand and matched to its line, reads as the line's bank text.
    expect(report.noPayee.byHand.transactions).toBe(0);
    expect(report.unnamed.some((group) => group.key.includes("wework"))).toBe(true);
  });

  test("with payees named, the rows move out of the unnamed list and the whole still adds up", async () => {
    const m = await book();
    const state = await stateOf(m.world);
    const texts = await textsOf(m.world);
    const payees = [
      payee("chipotle", "Chipotle", "chipotle"),
      payee("uber", "Uber", "uber"),
      payee("stripe", "Stripe", "stripe"),
      payee("wework", "WeWork", "wework"),
      payee("northwind", "Northwind LLC", "northwind"),
      payee("jane", "Jane Roe", "jane roe"),
      // A tie: "adobe creative" and "creative cloud" are the same length and both are in Adobe's text.
      payee("adobe-a", "Adobe", "adobe creative"),
      payee("adobe-b", "Creative Cloud", "creative cloud"),
    ];
    const expected = oracle(m);
    for (const range of [
      { from: "2026-03-01", to: "2026-03-31" },
      { from: "2026-01-01", to: "2026-12-31" },
      { from: "2026-03-10", to: "2026-03-20" },
    ]) {
      const report = compilePayeeTotals({ state, ...range, payees, texts });
      const sum = (pick: (t: { received: bigint; spent: bigint }) => bigint) =>
        report.rows.reduce((total, row) => total + pick(row), 0n) +
        report.unnamed.reduce((total, row) => total + pick(row), 0n) +
        report.ambiguous.reduce((total, row) => total + pick(row), 0n) +
        pick(report.noPayee.byHand) +
        pick(report.noPayee.noBankText);
      expect(sum((t) => t.received)).toBe(report.profitLoss.income);
      expect(sum((t) => t.spent)).toBe(report.profitLoss.expenses);
      if (range.from === "2026-03-01" || range.from === "2026-01-01") {
        expect(report.profitLoss.income).toBe(expected.totalRevenue);
        expect(report.profitLoss.expenses).toBe(expected.totalExpenses);
      }
      expect(report.ambiguous.length).toBeGreaterThanOrEqual(range.from === "2026-03-10" ? 0 : 1);
    }
    const march = compilePayeeTotals({
      state,
      from: "2026-03-01",
      to: "2026-03-31",
      payees,
      texts,
    });
    const row = (id: string) => march.rows.find((r) => r.payeeId === id);
    // Uber's refund comes off its own side: five rides and a 25.00 credit.
    expect(row("uber")).toMatchObject({
      transactions: 6,
      received: 0n,
      spent:
        cents("23.75") +
        cents("31.40") +
        cents("18.20") +
        cents("27.80") +
        cents("22.50") -
        cents("25.00"),
    });
    expect(row("jane")).toMatchObject({ transactions: 1, spent: cents("400.00") });
    expect(row("wework")).toMatchObject({ transactions: 1, spent: cents("750.00") });
    // Both of the Adobe payees are in "ADOBE *CREATIVE CLOUD": it is given to neither and listed.
    expect(march.ambiguous).toHaveLength(1);
    expect(march.ambiguous[0]).toMatchObject({ payeeIds: ["adobe-a", "adobe-b"], transactions: 4 });
    expect(row("adobe-a")).toBeUndefined();
    // Largest first.
    const abs = (value: bigint) => (value < 0n ? -value : value);
    const sizes = march.rows.map((r) => abs(r.received) + abs(r.spent));
    expect([...sizes].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))).toEqual(sizes);
    // Two invoices from Northwind came in; the one dated before the cutover is in the opening balance.
    expect(dec(row("northwind")?.received ?? 0n)).toBe("2550.00");
  });

  test("by month the same places add up to each month's profit and loss", async () => {
    const m = await book();
    const state = await stateOf(m.world);
    const report = compilePayeeTotals({
      state,
      from: "2026-01-01",
      to: "2026-06-30",
      payees: [payee("stripe", "Stripe", "stripe")],
      texts: await textsOf(m.world),
      byMonth: true,
    });
    expect(report.months?.map((month) => month.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
    const march = report.rows.find((row) => row.payeeId === "stripe");
    expect(march?.months?.map((month) => month.transactions)).toEqual([0, 0, 6, 0, 0, 0]);
    const core = compileCoreReports(state, "2026-03-31", { from: "2026-03-01" });
    const marchTie = report.months?.find((month) => month.month === "2026-03");
    expect(marchTie).toMatchObject({
      profitLossIncome: cents(core.profitAndLoss.revenue),
      profitLossExpenses: cents(core.profitAndLoss.expenses),
    });
  });

  test("the report is a function of the book, the payees and the texts: the same inputs, the same everything", async () => {
    const m = await book();
    const state = await stateOf(m.world);
    const texts = await textsOf(m.world);
    const input = {
      state,
      from: "2026-03-01",
      to: "2026-03-31",
      payees: [payee("stripe", "Stripe", "stripe")],
      texts,
    };
    const same = (_key: string, value: unknown) =>
      typeof value === "bigint" ? String(value) : value;
    expect(JSON.stringify(compilePayeeTotals(input), same)).toBe(
      JSON.stringify(compilePayeeTotals(input), same),
    );
  });
});

describe("months of a range", () => {
  test("are the calendar months it touches, each cut to the range", () => {
    expect(monthsOf("2026-01-15", "2026-03-10")).toEqual([
      { month: "2026-01", from: "2026-01-15", to: "2026-01-31" },
      { month: "2026-02", from: "2026-02-01", to: "2026-02-28" },
      { month: "2026-03", from: "2026-03-01", to: "2026-03-10" },
    ]);
    expect(monthsOf("2026-12-05", "2027-01-02")).toEqual([
      { month: "2026-12", from: "2026-12-05", to: "2026-12-31" },
      { month: "2027-01", from: "2027-01-01", to: "2027-01-02" },
    ]);
    expect(monthsOf("2026-03-31", "2026-03-31")).toEqual([
      { month: "2026-03", from: "2026-03-31", to: "2026-03-31" },
    ]);
  });
});

describe("the tie-out holds for any book", () => {
  test("a seeded property: random books with reversals, supersessions and backdated entries, random payees and random text", () => {
    const vocabulary = ["acme", "bravo", "coffee", "delta", "echo", "fuel", "gold", "hotel"];
    let compared = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const random = sequence(seed * 7919);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
      const book = playRandomBook({ seed, steps: 70 + (seed % 5) * 20, sources: seed % 2 === 0 });
      const state = book.state;
      const journalIds = state.journals.map((booked) => booked.journal.id as string);
      if (journalIds.length === 0) continue;
      // Text for some of the journals: a counterparty, a description, a connector, or none at all.
      const texts = new Map<string, JournalText>();
      for (const id of journalIds) {
        const roll = random();
        if (roll < 0.15) continue;
        const phrase = () =>
          Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(vocabulary)).join(" ");
        texts.set(
          id,
          roll < 0.25
            ? { counterparty: "", description: "", connector: "Stripe" }
            : {
                counterparty: random() < 0.5 ? phrase().toUpperCase() : "",
                description: `${phrase()} ${Math.floor(random() * 90)}`,
              },
        );
      }
      const payees: PayeeRecord[] = Array.from({ length: Math.floor(random() * 6) }, (_, n) =>
        payee(
          `p${n}`,
          `Payee ${n}`,
          ...Array.from({ length: 1 + Math.floor(random() * 2) }, () =>
            Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(vocabulary)).join(" "),
          ),
        ),
      );
      const dates = state.journals.map((booked) => booked.journal.accountingDate as string).sort();
      const last = `${(dates.at(-1) as string).slice(0, 4)}-12-31`;
      const first = `${(dates[0] as string).slice(0, 4)}-01-01`;
      for (const range of [
        { from: first, to: last },
        { from: first, to: dates[Math.floor(dates.length / 2)] as string },
      ]) {
        const report = compilePayeeTotals({ state, ...range, payees, texts });
        const core = compileCoreReports(state, range.to, { from: range.from });
        expect(report.totals.received, `seed ${seed}`).toBe(cents(core.profitAndLoss.revenue));
        expect(report.totals.spent, `seed ${seed}`).toBe(cents(core.profitAndLoss.expenses));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(40);
  });
});

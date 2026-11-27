import { describe, expect, test } from "bun:test";
import type { AccountTagMap } from "../src/account-tags.ts";
import { buildTagMap, type TagRecord } from "../src/chart/tags.ts";
import { salesHeader, salesPostingsCsv, salesSummaryCsv } from "../src/tax/sales-csv.ts";
import {
  analyzeSalesTax,
  MAX_SALES_PERIODS,
  SALES_TAX_ROLE_KEY,
  SALES_TAX_STATEMENT,
  salesPeriods,
  type SalesTaxRequest,
  type StripePayoutTax,
} from "../src/tax/sales.ts";
import { KernelBook } from "./support/kernel-book.ts";

const C = (dollars: number, cents = 0) => BigInt(dollars) * 100n + BigInt(cents);

// ---------------------------------------------------------------------------------------------
// A year of sales-tax activity as plain data. Every expected figure below is worked out by hand from
// this list (the arithmetic is in the comments), not by the code under test.
// ---------------------------------------------------------------------------------------------
const accounts = [
  { code: "1000", role: "asset" as const, name: "Checking" },
  { code: "1100", role: "asset" as const, name: "Stripe balance" },
  { code: "2000", role: "liability" as const, name: "Credit card" },
  { code: "2500", role: "liability" as const, name: "Sales tax payable" },
  { code: "3000", role: "equity" as const, name: "Owner investment" },
  { code: "4000", role: "income" as const, name: "Sales" },
];

type Entry = {
  date: string;
  memo: string;
  lines: readonly (readonly [string, bigint])[];
  /** Present when the entry books a Stripe payout: the tax leg Stripe reported on it, ledger-signed
   * (a credit, tax collected, is negative). */
  stripe?: bigint;
};

const ENTRIES: readonly Entry[] = [
  // Last year: 30.00 collected and not paid, so the range opens with 30.00.
  {
    date: "2025-12-20",
    memo: "Sale typed in",
    lines: [
      ["1000", C(1030)],
      ["4000", -C(1000)],
      ["2500", -C(30)],
    ],
  },
  // January: 8.00 by hand and 37.50 on a Stripe payout.
  {
    date: "2026-01-15",
    memo: "Sale typed in",
    lines: [
      ["1000", C(108)],
      ["4000", -C(100)],
      ["2500", -C(8)],
    ],
  },
  {
    date: "2026-01-31",
    memo: "Stripe payout po_jan",
    lines: [
      ["1100", C(500)],
      ["4000", -C(462, 50)],
      ["2500", -C(37, 50)],
    ],
    stripe: -C(37, 50),
  },
  // February: 16.00 on a payout; 80.00 paid to the state.
  {
    date: "2026-02-10",
    memo: "Stripe payout po_feb",
    lines: [
      ["1100", C(216)],
      ["4000", -C(200)],
      ["2500", -C(16)],
    ],
    stripe: -C(16),
  },
  {
    date: "2026-02-20",
    memo: "Payment to the state",
    lines: [
      ["2500", C(80)],
      ["1000", -C(80)],
    ],
  },
  // March: a payout that nets 2.00 of returned tax against its sales.
  {
    date: "2026-03-05",
    memo: "Stripe payout po_mar",
    lines: [
      ["1100", C(100)],
      ["2500", C(2)],
      ["4000", -C(102)],
    ],
    stripe: C(2),
  },
  // April: 4.00 by hand.
  {
    date: "2026-04-15",
    memo: "Sale typed in",
    lines: [
      ["1000", C(54)],
      ["4000", -C(50)],
      ["2500", -C(4)],
    ],
  },
  // June: the account took 20.00 from a payout on which Stripe reported 22.00.
  {
    date: "2026-06-10",
    memo: "Stripe payout po_jun",
    lines: [
      ["1100", C(300)],
      ["4000", -C(280)],
      ["2500", -C(20)],
    ],
    stripe: -C(22),
  },
  // December: 10.00 on a payout.
  {
    date: "2026-12-31",
    memo: "Stripe payout po_dec",
    lines: [
      ["1100", C(110)],
      ["4000", -C(100)],
      ["2500", -C(10)],
    ],
    stripe: -C(10),
  },
];

const tag = (accountId: string, value: string | null, effectiveOn = "0001-01-01"): TagRecord => ({
  seq: 0,
  accountId,
  tag: "roleKey",
  effectiveOn,
  value,
});
const tagMap = (...records: TagRecord[]): AccountTagMap =>
  buildTagMap(
    records.map((record, index) => ({ ...record, seq: index + 1 })),
    records.length,
  );
const TAGGED = tagMap(tag("2500", SALES_TAX_ROLE_KEY));

function book(entries: readonly Entry[] = ENTRIES) {
  const kernel = new KernelBook({ basis: "cash", firstYear: 2025, years: 2, accounts });
  const payouts: StripePayoutTax[] = [];
  for (const entry of entries) {
    const id = kernel.post(entry.date, entry.lines, entry.memo);
    if (entry.stripe !== undefined)
      payouts.push({ journalId: id, providerId: `po_${entry.date}`, cents: entry.stripe });
  }
  return { kernel, payouts };
}

const request = (
  payouts: readonly StripePayoutTax[] | null,
  over: Partial<SalesTaxRequest> = {},
): SalesTaxRequest => ({
  taxYear: 2026,
  from: "2026-01-01",
  to: "2026-12-31",
  period: "month",
  tags: TAGGED,
  today: "2027-01-15",
  booksStartOn: null,
  stripePayouts: payouts,
  stripe: { configured: true, salesTax: "stripe", taxNotReported: 0, refundsWithoutTaxSplit: 0 },
  ...over,
});

const periodOf = (summary: ReturnType<typeof analyzeSalesTax>["summary"], key: string) => {
  const found = summary.periods.find((period) => period.key === key);
  if (!found) throw new Error(`No period ${key}`);
  return found;
};

describe("the periods of a range", () => {
  test("calendar months and quarters are cut at the ends of the range", () => {
    expect(
      salesPeriods("2026-01-01", "2026-03-31", "month").map((p) => [p.key, p.from, p.to]),
    ).toEqual([
      ["2026-01", "2026-01-01", "2026-01-31"],
      ["2026-02", "2026-02-01", "2026-02-28"],
      ["2026-03", "2026-03-01", "2026-03-31"],
    ]);
    expect(salesPeriods("2026-02-10", "2026-05-20", "month").map((p) => [p.from, p.to])).toEqual([
      ["2026-02-10", "2026-02-28"],
      ["2026-03-01", "2026-03-31"],
      ["2026-04-01", "2026-04-30"],
      ["2026-05-01", "2026-05-20"],
    ]);
    expect(salesPeriods("2026-01-01", "2026-12-31", "quarter").map((p) => [p.key, p.to])).toEqual([
      ["2026-Q1", "2026-03-31"],
      ["2026-Q2", "2026-06-30"],
      ["2026-Q3", "2026-09-30"],
      ["2026-Q4", "2026-12-31"],
    ]);
    expect(
      salesPeriods("2026-02-15", "2026-08-10", "quarter").map((p) => [p.key, p.from, p.to]),
    ).toEqual([
      ["2026-Q1", "2026-02-15", "2026-03-31"],
      ["2026-Q2", "2026-04-01", "2026-06-30"],
      ["2026-Q3", "2026-07-01", "2026-08-10"],
    ]);
    expect(salesPeriods("2026-01-01", "2026-12-31", "year")).toEqual([
      { key: "2026", from: "2026-01-01", to: "2026-12-31" },
    ]);
    // a leap year's February
    expect(salesPeriods("2028-02-01", "2028-02-29", "month")[0]?.to).toBe("2028-02-29");
  });

  test("a range of more periods than a summary covers is refused", () => {
    expect(() => salesPeriods("2000-01-01", "2010-12-31", "month")).toThrow();
    expect(salesPeriods("2000-01-01", "2004-12-31", "month")).toHaveLength(MAX_SALES_PERIODS);
  });
});

describe("the sales-tax summary", () => {
  const { kernel, payouts } = book();
  const { summary, postings } = analyzeSalesTax(kernel.state, request(payouts));

  test("opens with what was collected and not paid before the range and carries it month to month", () => {
    expect(summary.accounts).toEqual([
      { accountId: "2500", code: "2500", name: "Sales tax payable", balance: "43.50" },
    ]);
    expect(summary.candidates).toEqual([]);
    // opening 30.00; collected 8 + 37.50 + 16 + 4 + 20 + 10 = 95.50; paid 80 + 2 = 82.00; closing 43.50
    expect([summary.opening, summary.collected, summary.remitted, summary.closing]).toEqual([
      "30.00",
      "95.50",
      "82.00",
      "43.50",
    ]);
    const months = summary.periods.map((p) => [
      p.key,
      p.opening,
      p.collected,
      p.remitted,
      p.closing,
    ]);
    expect(months).toEqual([
      ["2026-01", "30.00", "45.50", "0.00", "75.50"],
      ["2026-02", "75.50", "16.00", "80.00", "11.50"],
      ["2026-03", "11.50", "0.00", "2.00", "9.50"],
      ["2026-04", "9.50", "4.00", "0.00", "13.50"],
      ["2026-05", "13.50", "0.00", "0.00", "13.50"],
      ["2026-06", "13.50", "20.00", "0.00", "33.50"],
      ["2026-07", "33.50", "0.00", "0.00", "33.50"],
      ["2026-08", "33.50", "0.00", "0.00", "33.50"],
      ["2026-09", "33.50", "0.00", "0.00", "33.50"],
      ["2026-10", "33.50", "0.00", "0.00", "33.50"],
      ["2026-11", "33.50", "0.00", "0.00", "33.50"],
      ["2026-12", "33.50", "10.00", "0.00", "43.50"],
    ]);
    expect(summary.periods.map((p) => p.postings)).toEqual([2, 2, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1]);
  });

  test("quarters and the whole range add up to the same figures", () => {
    const quarters = analyzeSalesTax(kernel.state, request(payouts, { period: "quarter" })).summary;
    expect(
      quarters.periods.map((p) => [p.key, p.opening, p.collected, p.remitted, p.closing]),
    ).toEqual([
      ["2026-Q1", "30.00", "61.50", "82.00", "9.50"],
      ["2026-Q2", "9.50", "24.00", "0.00", "33.50"],
      ["2026-Q3", "33.50", "0.00", "0.00", "33.50"],
      ["2026-Q4", "33.50", "10.00", "0.00", "43.50"],
    ]);
    const year = analyzeSalesTax(kernel.state, request(payouts, { period: "year" })).summary;
    expect(year.periods).toHaveLength(1);
    expect(periodOf(year, "2026")).toMatchObject({
      opening: "30.00",
      collected: "95.50",
      remitted: "82.00",
      closing: "43.50",
      postings: 8,
    });
  });

  test("sets what the account took from Stripe payouts against what Stripe reported on them", () => {
    // booked: 37.50 + 16.00 - 2.00 + 20.00 + 10.00 = 81.50; reported: 37.50 + 16.00 - 2.00 + 22.00 + 10.00 = 83.50
    expect(summary.stripe).toMatchObject({
      read: true,
      payouts: 5,
      booked: "81.50",
      reported: "83.50",
      salesTax: "stripe",
      taxNotReported: 0,
      refundsWithoutTaxSplit: 0,
    });
    expect(periodOf(summary, "2026-01")).toMatchObject({
      stripeBooked: "37.50",
      stripeReported: "37.50",
      stripeDifference: "0.00",
    });
    expect(periodOf(summary, "2026-03")).toMatchObject({
      stripeBooked: "-2.00",
      stripeReported: "-2.00",
      stripeDifference: "0.00",
    });
    expect(periodOf(summary, "2026-06")).toMatchObject({
      stripeBooked: "20.00",
      stripeReported: "22.00",
      stripeDifference: "-2.00",
    });
    const warning = summary.warnings.find((w) => w.code === "stripe_differs");
    expect(warning?.message).toContain("2026-06");
    // A month with no Stripe payout has nothing to compare.
    expect(periodOf(summary, "2026-04")).toMatchObject({
      stripeBooked: "0.00",
      stripeReported: "0.00",
    });
  });

  test("lists every posting on the account with where it came from, and the rows add up to the periods", () => {
    expect(postings).toHaveLength(8);
    const collected = postings.reduce((sum, row) => sum + row.collected, 0n);
    const paid = postings.reduce((sum, row) => sum + row.paid, 0n);
    expect([collected, paid]).toEqual([C(95, 50), C(82)]);
    expect(postings.filter((row) => row.origin === "stripe").map((row) => row.narration)).toEqual([
      "Stripe payout po_jan",
      "Stripe payout po_feb",
      "Stripe payout po_mar",
      "Stripe payout po_jun",
      "Stripe payout po_dec",
    ]);
    expect(postings.find((row) => row.narration === "Payment to the state")).toMatchObject({
      origin: "other",
      collected: 0n,
      paid: C(80),
      period: "2026-02",
    });
    // Every row is a posting of a journal the book holds.
    const journalIds = new Set(kernel.state.journals.map((booked) => booked.journal.id as string));
    expect(postings.every((row) => journalIds.has(row.journalId))).toBe(true);
  });

  test("says in plain words what Rastrata does not know, and never what is owed", () => {
    expect(summary.statement).toBe(SALES_TAX_STATEMENT);
    expect(summary.statement).toContain("does not know your sales tax rates");
    expect(summary.statement).toContain("when a return is due");
    expect(summary.disclaimer).toContain("does not give tax advice");
    // Outside the statement, the notes and the disclaimer, which say what is not known, no figure or
    // warning claims anything is owed.
    const figures = JSON.stringify({ ...summary, statement: "", notes: [], disclaimer: "" });
    expect(figures.toLowerCase()).not.toContain("owe");
    expect(summary.warnings.map((w) => w.code)).toEqual(["stripe_differs"]);
  });

  test("is a function of its inputs: the same book gives the same figures and hash, and any change moves the hash", () => {
    const again = analyzeSalesTax(kernel.state, request(payouts)).summary;
    expect(again).toEqual(summary);
    const quarters = analyzeSalesTax(kernel.state, request(payouts, { period: "quarter" })).summary;
    expect(quarters.populationHash).not.toBe(summary.populationHash);
    const retagged = analyzeSalesTax(
      kernel.state,
      request(payouts, { tags: tagMap(tag("2500", SALES_TAX_ROLE_KEY), tag("1000", "other.key")) }),
    ).summary;
    expect(retagged.populationHash).not.toBe(summary.populationHash);
    const changedEvidence = analyzeSalesTax(
      kernel.state,
      request(
        payouts.map((payout, index) =>
          index === 0 ? { ...payout, cents: payout.cents - 1n } : payout,
        ),
      ),
    ).summary;
    expect(changedEvidence.populationHash).not.toBe(summary.populationHash);
  });
});

describe("a part of the year", () => {
  test("opens with the balance at the start of the range and ends where the whole-year figures do", () => {
    const { kernel, payouts } = book();
    const { summary } = analyzeSalesTax(
      kernel.state,
      request(payouts, { from: "2026-02-01", to: "2026-03-31", today: "2026-12-31" }),
    );
    // balance at the end of January: 30.00 + 45.50 = 75.50
    expect(summary.opening).toBe("75.50");
    expect(summary.periods.map((p) => [p.key, p.closing])).toEqual([
      ["2026-02", "11.50"],
      ["2026-03", "9.50"],
    ]);
    expect(summary.closing).toBe("9.50");
    expect(summary.accounts[0]?.balance).toBe("9.50");
    expect(summary.warnings.map((w) => w.code)).toContain("range_not_calendar_year");
    // The Stripe payouts of January and later months are not in this range.
    expect(summary.stripe.payouts).toBe(2);
  });

  test("says the year is not over when the range ends after today", () => {
    const { kernel, payouts } = book();
    const { summary } = analyzeSalesTax(kernel.state, request(payouts, { today: "2026-06-30" }));
    expect(summary.warnings.map((w) => w.code)).toContain("year_not_ended");
  });

  test("says when the books start part-way through the range", () => {
    const { kernel, payouts } = book();
    const { summary } = analyzeSalesTax(
      kernel.state,
      request(payouts, { booksStartOn: "2026-03-01" }),
    );
    expect(summary.warnings.map((w) => w.code)).toContain("books_start_late");
  });
});

describe("the tag", () => {
  test("no account tagged: nothing is summarised, and the liability accounts that could be are listed with a hint", () => {
    const { kernel, payouts } = book();
    const { summary, postings } = analyzeSalesTax(
      kernel.state,
      request(payouts, { tags: tagMap() }),
    );
    expect(summary.accounts).toEqual([]);
    expect(postings).toEqual([]);
    expect([summary.opening, summary.collected, summary.remitted, summary.closing]).toEqual([
      "0.00",
      "0.00",
      "0.00",
      "0.00",
    ]);
    expect(summary.candidates).toEqual([
      { accountId: "2000", code: "2000", name: "Credit card", suggested: false },
      { accountId: "2500", code: "2500", name: "Sales tax payable", suggested: true },
    ]);
  });

  test("an account that is not a liability is left out, with the reason", () => {
    const { kernel, payouts } = book();
    const { summary } = analyzeSalesTax(
      kernel.state,
      request(payouts, { tags: tagMap(tag("1100", SALES_TAX_ROLE_KEY)) }),
    );
    expect(summary.accounts).toEqual([]);
    expect(summary.warnings.map((w) => w.code)).toContain("account_not_liability");
  });

  test("a tag moved to another account during the range counts both, and says so", () => {
    const { kernel, payouts } = book();
    const moved = tagMap(
      tag("2500", SALES_TAX_ROLE_KEY),
      tag("2500", null, "2026-07-01"),
      tag("2000", SALES_TAX_ROLE_KEY, "2026-07-01"),
    );
    const { summary } = analyzeSalesTax(kernel.state, request(payouts, { tags: moved }));
    expect(summary.accounts.map((a) => a.code)).toEqual(["2000", "2500"]);
    expect(summary.warnings.map((w) => w.code)).toContain("several_accounts");
    // The card account has no activity, so the figures are the sales tax account's.
    expect(summary.closing).toBe("43.50");
  });

  test("a tag that begins part-way through the range is read as the tags stand on its last day", () => {
    const { kernel, payouts } = book();
    const late = tagMap(tag("2500", SALES_TAX_ROLE_KEY, "2026-07-01"));
    const { summary } = analyzeSalesTax(kernel.state, request(payouts, { tags: late }));
    expect(summary.accounts.map((a) => a.code)).toEqual(["2500"]);
    expect(summary.closing).toBe("43.50");
  });
});

describe("when Stripe could not be read", () => {
  test("the ledger figures stand, the comparison is empty and the summary says why", () => {
    const { kernel } = book();
    const { summary } = analyzeSalesTax(kernel.state, request(null, { stripe: null }));
    expect(summary.closing).toBe("43.50");
    expect(summary.stripe).toMatchObject({
      read: false,
      payouts: 0,
      booked: "0.00",
      reported: "0.00",
      salesTax: null,
      taxNotReported: null,
    });
    expect(summary.warnings.map((w) => w.code)).toContain("stripe_not_read");
    expect(periodOf(summary, "2026-06").stripeDifference).toBe("0.00");
  });

  test("charges Stripe gave no tax figure for are reported and never guessed", () => {
    const { kernel, payouts } = book();
    const { summary } = analyzeSalesTax(
      kernel.state,
      request(payouts, {
        stripe: {
          configured: true,
          salesTax: "stripe",
          taxNotReported: 3,
          refundsWithoutTaxSplit: 1,
        },
      }),
    );
    const warning = summary.warnings.find((w) => w.code === "stripe_tax_not_reported");
    expect(warning?.message).toContain("3 Stripe charges");
    expect(summary.stripe).toMatchObject({ taxNotReported: 3, refundsWithoutTaxSplit: 1 });
  });
});

describe("an account that holds more tax paid than collected", () => {
  test("is flagged, not hidden", () => {
    const { kernel, payouts } = book([
      ...ENTRIES.slice(0, 2),
      {
        date: "2026-02-20",
        memo: "Payment to the state",
        lines: [
          ["2500", C(100)],
          ["1000", -C(100)],
        ],
      },
    ]);
    const { summary } = analyzeSalesTax(kernel.state, request(payouts));
    // 30 + 8 - 100 = -62
    expect(summary.closing).toBe("-62.00");
    expect(summary.warnings.map((w) => w.code)).toContain("negative_balance");
  });
});

describe("the files", () => {
  test("neutralise text a spreadsheet could run as a formula, and keep every figure a plain number", () => {
    const hostile: readonly Entry[] = [
      {
        date: "2026-01-15",
        memo: '=HYPERLINK("http://example.invalid","x")',
        lines: [
          ["1000", C(108)],
          ["4000", -C(100)],
          ["2500", -C(8)],
        ],
      },
    ];
    const { kernel } = book(hostile);
    const analysis = analyzeSalesTax(kernel.state, request([]));
    const header = salesHeader(analysis.summary, '=cmd|"/c calc"!A1');
    const postings = salesPostingsCsv(header, analysis.postings);
    const summary = salesSummaryCsv(header, analysis.summary);
    for (const file of [postings, summary])
      for (const line of file.split("\r\n"))
        for (const cell of line.split(",")) expect(/^"?[=+@\t]/.test(cell)).toBe(false);
    expect(postings).toContain("'=HYPERLINK");
    expect(summary).toContain("Whole range");
    // headed by the population it came from
    expect(summary).toContain(analysis.summary.populationHash);
    expect(summary.split("\r\n").some((line) => line.includes("8.00"))).toBe(true);
  });
});

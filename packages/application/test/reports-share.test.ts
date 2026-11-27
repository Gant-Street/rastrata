import { describe, expect, test } from "bun:test";
import { compileReports } from "../src/reports.ts";
import { exportStatement, type ExportRequest } from "../src/reports/export.ts";
import { formatShare, shareTenths } from "../src/reports/statements.ts";
import { failure } from "./support/helpers.ts";
import { KernelBook, type AccountSpec } from "./support/kernel-book.ts";
import { tagMap } from "./support/tags.ts";

/** The share of income: a profit and loss line as a percentage of the same profit and loss's total
 * income, to one decimal place, rounded half away from zero, from integers.
 *
 * Every expected figure below was worked out by hand and written down before the code was: the
 * working is the comment above it. None is read back from the code under test. */

// ---- The rounding rule, on its own --------------------------------------------------------------
//
// The share in tenths of a percent is amount x 1000 / income (a cent of each cancels). It is rounded
// to a whole number of tenths, a tie going away from zero, and written with one decimal.

/** [what it shows, the amount in cents, the income in cents, the share written by hand] */
const VECTORS: readonly (readonly [string, bigint, bigint, string])[] = [
  // ----- ordinary lines
  // 100.00 of 400.00: 10,000 x 1,000 / 40,000 = 250 tenths = 25.0%.
  ["a quarter", 10_000n, 40_000n, "25.0"],
  // 1 of 3 cents: 1,000 / 3 = 333.33 tenths, below the tie, so 333 = 33.3%.
  ["a third", 1n, 3n, "33.3"],
  // 2 of 3 cents: 2,000 / 3 = 666.67 tenths, above the tie, so 667 = 66.7%.
  ["two thirds", 2n, 3n, "66.7"],
  // 1 of 8 cents: 1,000 / 8 = 125 tenths exactly = 12.5%.
  ["an eighth, with nothing to round", 1n, 8n, "12.5"],
  // 1,208.00 of 4,000.00: 120,800 x 1,000 / 400,000 = 302 tenths exactly = 30.2%.
  ["advertising of a month's income", 120_800n, 400_000n, "30.2"],

  // ----- a rounding tie, either side of zero (a tie goes away from zero, not to even, not upward)
  // 5 cents of 20.00: 5 x 1,000 / 2,000 = 2.5 tenths = 0.25%: a tie, away from zero is 3 tenths.
  ["a tie above zero, where even would give 0.2", 5n, 2_000n, "0.3"],
  // -5 cents of 20.00: -2.5 tenths = -0.25%: a tie, away from zero is -3 (round half up would give -2).
  ["a tie below zero, where rounding half up would give -0.2", -5n, 2_000n, "-0.3"],
  // 15 cents of 20.00: 7.5 tenths: a tie, away from zero is 8.
  ["a tie that even and away from zero agree on", 15n, 2_000n, "0.8"],
  ["the same tie below zero", -15n, 2_000n, "-0.8"],
  // 25 cents of 20.00: 12.5 tenths = 1.25%: a tie, away from zero is 13 (even would give 12).
  ["a tie at 1.25%", 25n, 2_000n, "1.3"],
  ["a tie at -1.25%", -25n, 2_000n, "-1.3"],
  // 10,000.00 is 1,000,000 cents, so amount x 1,000 / 1,000,000 = amount / 1,000 tenths.
  // 1,499 -> 1.499 tenths: below the tie, 1. 1,500 -> 1.5: the tie, 2. 1,501 -> 1.501: above, 2.
  ["just below a tie", 1_499n, 1_000_000n, "0.1"],
  ["on the tie", 1_500n, 1_000_000n, "0.2"],
  ["just above a tie", 1_501n, 1_000_000n, "0.2"],
  ["just below a tie, under zero", -1_499n, 1_000_000n, "-0.1"],
  ["on the tie, under zero", -1_500n, 1_000_000n, "-0.2"],
  ["just above a tie, under zero", -1_501n, 1_000_000n, "-0.2"],
  // 500 of 1,000,000: 0.5 tenths: a tie, away from zero is 1 tenth = 0.1%.
  ["half a tenth", 500n, 1_000_000n, "0.1"],
  ["half a tenth, under zero", -500n, 1_000_000n, "-0.1"],
  // 499 of 1,000,000: 0.499 tenths rounds to nothing.
  ["under half a tenth", 499n, 1_000_000n, "0.0"],

  // ----- zero is zero: never "-0.0"
  ["nothing", 0n, 100n, "0.0"],
  // -499 of 1,000,000: -0.499 tenths rounds to 0. A figure that rounds to nothing has no sign.
  ["under half a tenth, under zero, which has no sign", -499n, 1_000_000n, "0.0"],
  // -1 of 5,000 (50.00): -1,000 / 5,000 = -0.2 tenths rounds to 0.
  ["a cent of a large income, under zero", -1n, 5_000n, "0.0"],

  // ----- a line equal to total income, and larger or smaller than it
  // x of x is 1,000 tenths = 100.0%.
  ["a line equal to total income", 1_234_567n, 1_234_567n, "100.0"],
  ["a single cent that is all the income", 1n, 1n, "100.0"],
  // 150.00 of 100.00: 15,000 x 1,000 / 10,000 = 1,500 tenths = 150.0%.
  ["an expense larger than the income", 15_000n, 10_000n, "150.0"],
  // -1,470.00 of 5,000.00: -147,000 x 1,000 / 500,000 = -294 tenths = -29.4%.
  ["a loss", -147_000n, 500_000n, "-29.4"],
  // 6,470.00 of 5,000.00: 1.294 = 129.4%.
  ["expenses above income", 647_000n, 500_000n, "129.4"],

  // ----- the largest amounts the format allows: sixteen digits before the point, 9,999,999,999,999,999.99
  // that is 999,999,999,999,999,999 cents. Call it D. D x 1,000 = 999,999,999,999,999,999,000.
  ["all of the largest income", 999_999_999_999_999_999n, 999_999_999_999_999_999n, "100.0"],
  // 1 x 1,000 / D = 0.000000000000001 tenths.
  ["one cent of the largest income", 1n, 999_999_999_999_999_999n, "0.0"],
  // 999,499,999,999,999,999 x 1,000 = D x 999 + 499,999,999,999,999,999, and twice that remainder
  // is 999,999,999,999,999,998 = D - 1, one short of half of D: the rounding goes down to 999 = 99.9%.
  // (Done in floating point this is 999.5 exactly and rounds up to 100.0: the reason for integers.)
  [
    "one cent short of the tie at the largest income",
    999_499_999_999_999_999n,
    999_999_999_999_999_999n,
    "99.9",
  ],
  // 999,500,000,000,000,000 x 1,000 = D x 999 + 500,000,000,000,000,999; twice that is more than D: 1,000.
  ["on the other side of that tie", 999_500_000_000_000_000n, 999_999_999_999_999_999n, "100.0"],
  ["and under zero", -999_499_999_999_999_999n, 999_999_999_999_999_999n, "-99.9"],
  ["and under zero, the other side", -999_500_000_000_000_000n, 999_999_999_999_999_999n, "-100.0"],
  // 499,999,999,999,999 x 1,000 = 499,999,999,999,999,000; twice it, 999,999,999,999,998,000, is 1,999 short of D.
  [
    "a sliver under half a tenth of the largest income",
    499_999_999_999_999n,
    999_999_999_999_999_999n,
    "0.0",
  ],
  // 500,000,000,000,000 x 1,000 = 500,000,000,000,000,000; twice it, 1,000,000,000,000,000,000, is past D.
  ["the first amount that reaches it", 500_000_000_000_000n, 999_999_999_999_999_999n, "0.1"],
  // An income of ten such postings, 9,999,999,999,999,999,990 cents, is past 64 bits, and half of it,
  // 4,999,999,999,999,999,995, is exactly 500 tenths = 50.0%.
  [
    "half of an income past 64 bits",
    4_999_999_999_999_999_995n,
    9_999_999_999_999_999_990n,
    "50.0",
  ],
  // 10^27 x 1,000 / (2 x 10^30) = 0.5 tenths exactly: a tie, 0.1%.
  ["a tie at a size no float holds", 10n ** 27n, 2n * 10n ** 30n, "0.1"],
  ["and under zero", -(10n ** 27n), 2n * 10n ** 30n, "-0.1"],
];

describe("a share of income, worked out by hand", () => {
  for (const [name, amount, income, expected] of VECTORS)
    test(`${name}: ${amount} of ${income} cents is ${expected}%`, () => {
      expect(formatShare(shareTenths(amount, income))).toBe(expected);
    });

  test("income of zero or less has no share to take", () => {
    expect(() => shareTenths(1n, 0n)).toThrow(RangeError);
    expect(() => shareTenths(0n, 0n)).toThrow(RangeError);
    expect(() => shareTenths(1n, -100n)).toThrow(RangeError);
  });

  test("tenths are written with one decimal and a sign only when they are below zero", () => {
    expect(formatShare(0n)).toBe("0.0");
    expect(formatShare(5n)).toBe("0.5");
    expect(formatShare(-5n)).toBe("-0.5");
    expect(formatShare(1_000n)).toBe("100.0");
    expect(formatShare(-294n)).toBe("-29.4");
    // 10^30 tenths is 10^29 whole percent: a one and twenty-nine zeros, a point and a zero.
    expect(formatShare(10n ** 30n)).toBe(`1${"0".repeat(29)}.0`);
  });

  // Not a list of examples: the rule itself, written a second way that shares no step with the code
  // (a ratio compared in integers, never divided), over amounts of every size.
  test("the rule holds on a grid of ties and near-ties of every size", () => {
    const incomes = [
      1n,
      2n,
      3n,
      7n,
      8n,
      2_000n,
      4_001n,
      1_000_000n,
      99_999_999_999n,
      10n ** 18n - 1n,
    ];
    let checked = 0;
    for (const income of incomes)
      for (let step = -40n; step <= 40n; step++) {
        // Amounts around every multiple of half a tenth of income: 500 income / 1,000 per tenth.
        const base = (step * income) / 2000n;
        for (const amount of [base - 1n, base, base + 1n]) {
          const tenths = shareTenths(amount, income);
          // |1000 x amount / income - tenths| <= 1/2, and on a tie it is away from zero.
          const gap = 2n * (1000n * amount) - 2n * tenths * income;
          const absGap = gap < 0n ? -gap : gap;
          expect(absGap <= income, `${amount}/${income}`).toBe(true);
          if (absGap === income)
            expect(
              (tenths < 0n ? -tenths : tenths) >
                ((amount < 0n ? -amount : amount) * 1000n) / income,
              `${amount}/${income} tie`,
            ).toBe(true);
          // The sign of the share is the sign of the amount, except that a share of nothing has none.
          if (tenths !== 0n) expect(tenths < 0n).toBe(amount < 0n);
          // An amount and its opposite give opposite shares.
          expect(shareTenths(-amount, income)).toBe(-tenths);
          checked++;
        }
      }
    expect(checked).toBeGreaterThan(1_000);
  });
});

// ---- Through the compiler: a real book, the real statement ---------------------------------------

const CHART: readonly AccountSpec[] = [
  { code: "1000", role: "asset", name: "Operating cash" },
  { code: "3000", role: "equity", name: "Owner capital" },
  { code: "4000", role: "income", name: "Sales" },
  { code: "4100", role: "income", name: "Services" },
  { code: "4900", role: "gain", name: "Gain on sale" },
  { code: "5000", role: "expense", name: "Cost of goods" },
  { code: "6000", role: "expense", name: "Advertising" },
  { code: "6100", role: "expense", name: "Rent" },
];

/** A two-year book (2025 and 2026) with the entries given as [date, account, amount in cents], each
 * against cash. A debit-normal line (an expense) takes cash out; a credit-normal one (income) puts it in. */
function bookOf(entries: readonly (readonly [string, string, bigint])[]): KernelBook {
  const book = new KernelBook({ firstYear: 2025, years: 2, accounts: CHART });
  for (const [date, code, cents] of entries) {
    const income = code.startsWith("4");
    book.post(date, [
      ["1000", income ? cents : -cents],
      [code, income ? -cents : cents],
    ]);
  }
  return book;
}

const MARCH = { from: "2026-03-01", asOf: "2026-03-31" } as const;

/** The shares of a profit and loss by account code, with the totals as `total:KEY`. */
function sharesOf(report: ReturnType<typeof compileReports>) {
  const shares: Record<string, string | undefined> = {};
  for (const row of report.profitAndLoss.rows) shares[row.code] = row.share;
  for (const total of report.profitAndLoss.totals) shares[`total:${total.key}`] = total.share;
  return shares;
}
function comparativeSharesOf(report: ReturnType<typeof compileReports>) {
  const shares: Record<string, string | undefined> = {};
  for (const row of report.profitAndLoss.rows) shares[row.code] = row.comparativeShare;
  for (const total of report.profitAndLoss.totals)
    shares[`total:${total.key}`] = total.comparativeShare;
  return shares;
}
/** Whether any line of the profit and loss carries a share, of either kind. */
const carriesAShare = (report: ReturnType<typeof compileReports>): boolean =>
  [...report.profitAndLoss.rows, ...report.profitAndLoss.totals].some(
    (line) => "share" in line || "comparativeShare" in line,
  );

describe("the profit and loss with shares of income", () => {
  test("the month of the owner's questions: income 5,000.00, a loss of 1,470.00", () => {
    // Sales 3,500.00 and Services 1,500.00: total income 5,000.00.
    // Advertising 1,510.00, Rent 2,400.00, Cost of goods 2,560.00: total expenses 6,470.00.
    // Net income 5,000.00 - 6,470.00 = -1,470.00.
    const state = bookOf([
      ["2026-03-05", "4000", 350_000n],
      ["2026-03-06", "4100", 150_000n],
      ["2026-03-10", "6000", 151_000n],
      ["2026-03-11", "6100", 240_000n],
      ["2026-03-12", "5000", 256_000n],
    ]).state;
    const report = compileReports(state, MARCH.asOf, { from: MARCH.from, share: "income" });
    expect(report.profitAndLoss.netIncome).toBe("-1470.00");
    expect(sharesOf(report)).toStrictEqual({
      // 3,500 / 5,000 = 0.700 -> 70.0. 1,500 / 5,000 = 0.300 -> 30.0.
      "4000": "70.0",
      "4100": "30.0",
      // A gain account with nothing in it: 0 / 5,000 = 0.0.
      "4900": "0.0",
      // 2,560 / 5,000 = 0.512. 1,510 / 5,000 = 0.302. 2,400 / 5,000 = 0.480.
      "5000": "51.2",
      "6000": "30.2",
      "6100": "48.0",
      // Total income is the whole of itself. Gains are nothing. 6,470 / 5,000 = 1.294.
      "total:income": "100.0",
      "total:gain": "0.0",
      "total:expense": "129.4",
      // Income and gains 5,000 / 5,000. Net income -1,470 / 5,000 = -0.294.
      "total:revenue": "100.0",
      "total:netIncome": "-29.4",
    });
    // No comparison was asked for, so there is no share of one, and nothing to warn of.
    expect(Object.values(comparativeSharesOf(report)).every((share) => share === undefined)).toBe(
      true,
    );
    expect(report.warnings).toEqual([]);
    // The amounts are the amounts they were: the share adds beside a figure and changes none.
    const plain = compileReports(state, MARCH.asOf, { from: MARCH.from });
    expect(
      JSON.stringify(report.profitAndLoss.rows.map(({ share: _share, ...rest }) => rest)),
    ).toBe(JSON.stringify(plain.profitAndLoss.rows));
    expect(report.populationHash).toBe(plain.populationHash);
  });

  test("a tie is taken away from zero on either side, line by line and in the totals", () => {
    // Sales 20.00 = 2,000 cents. Advertising 20.05, Rent 0.25, and a refund into Cost of goods of 0.05.
    // Advertising 2,005 / 2,000 = 100.25% -> a tie -> 100.3 (even would give 100.2).
    // Rent 25 / 2,000 = 1.25% -> 1.3. Cost of goods -5 / 2,000 = -0.25% -> -0.3.
    // Total expenses 2,005 + 25 - 5 = 2,025 / 2,000 = 101.25% -> 101.3.
    // Net income 2,000 - 2,025 = -25 / 2,000 = -1.25% -> -1.3 (round half up would give -1.2).
    const state = bookOf([
      ["2026-03-05", "4000", 2_000n],
      ["2026-03-06", "6000", 2_005n],
      ["2026-03-07", "6100", 25n],
      ["2026-03-08", "5000", -5n],
    ]).state;
    const report = compileReports(state, MARCH.asOf, { from: MARCH.from, share: "income" });
    expect(report.profitAndLoss.netIncome).toBe("-0.25");
    expect(sharesOf(report)).toStrictEqual({
      "4000": "100.0",
      "4100": "0.0",
      "4900": "0.0",
      "5000": "-0.3",
      "6000": "100.3",
      "6100": "1.3",
      "total:income": "100.0",
      "total:gain": "0.0",
      "total:expense": "101.3",
      "total:revenue": "100.0",
      "total:netIncome": "-1.3",
    });
  });

  test("a line equal to total income is 100.0, and a net income of nothing is 0.0 and not -0.0", () => {
    // Sales 100.00. Advertising 100.00. Net income 0.00: 0 / 10,000 = 0.0.
    const state = bookOf([
      ["2026-03-05", "4000", 10_000n],
      ["2026-03-06", "6000", 10_000n],
    ]).state;
    const report = compileReports(state, MARCH.asOf, { from: MARCH.from, share: "income" });
    const shares = sharesOf(report);
    expect(shares["4000"]).toBe("100.0");
    expect(shares["6000"]).toBe("100.0");
    expect(shares["total:expense"]).toBe("100.0");
    expect(shares["total:netIncome"]).toBe("0.0");
    expect(JSON.stringify(report.profitAndLoss)).not.toContain('"-0.0"');
  });

  test("with no income there is no share to show, and the report says why", () => {
    // Advertising 200.00 and Rent 50.00 and nothing earned: income 0.00, so nothing to divide by.
    const state = bookOf([
      ["2026-03-06", "6000", 20_000n],
      ["2026-03-07", "6100", 5_000n],
    ]).state;
    const report = compileReports(state, MARCH.asOf, { from: MARCH.from, share: "income" });
    expect(report.profitAndLoss.totals.find((total) => total.key === "income")?.amount).toBe(
      "0.00",
    );
    expect(carriesAShare(report)).toBe(false);
    expect(report.warnings.map((warning) => warning.code)).toEqual(["share_unavailable"]);
    expect(report.warnings[0]?.message).toContain("no income");
    // The amounts are still all there.
    expect(report.profitAndLoss.netIncome).toBe("-250.00");
  });

  test("with income below zero there is no share either, and the report says that income is below zero", () => {
    // Sales reversed by a 40.00 refund with no sale in the range: income is -40.00. Advertising 10.00.
    const state = bookOf([
      ["2026-03-05", "4000", -4_000n],
      ["2026-03-06", "6000", 1_000n],
    ]).state;
    const report = compileReports(state, MARCH.asOf, { from: MARCH.from, share: "income" });
    expect(report.profitAndLoss.totals.find((total) => total.key === "income")?.amount).toBe(
      "-40.00",
    );
    expect(carriesAShare(report)).toBe(false);
    expect(report.warnings.map((warning) => warning.code)).toEqual(["share_unavailable"]);
    expect(report.warnings[0]?.message).toContain("less than zero");
  });

  test("a comparison column is divided by its own period's income", () => {
    // March 2026: Sales 200.00, Advertising 60.00. March 2025: Sales 400.00, Advertising 60.00.
    // 2026: 60 / 200 = 30.0; net income 140 / 200 = 70.0.
    // 2025: 60 / 400 = 15.0 (not 30.0, which is what the other period's income would give);
    // net income 340 / 400 = 85.0; total expenses 15.0.
    const state = bookOf([
      ["2026-03-05", "4000", 20_000n],
      ["2026-03-06", "6000", 6_000n],
      ["2025-03-05", "4000", 40_000n],
      ["2025-03-06", "6000", 6_000n],
    ]).state;
    const report = compileReports(state, MARCH.asOf, {
      from: MARCH.from,
      compare: "previousYear",
      share: "income",
    });
    expect(report.comparison?.periodStart).toBe("2025-03-01");
    expect(sharesOf(report)).toStrictEqual({
      "4000": "100.0",
      "4100": "0.0",
      "4900": "0.0",
      "5000": "0.0",
      "6000": "30.0",
      "6100": "0.0",
      "total:income": "100.0",
      "total:gain": "0.0",
      "total:expense": "30.0",
      "total:revenue": "100.0",
      "total:netIncome": "70.0",
    });
    expect(comparativeSharesOf(report)).toStrictEqual({
      "4000": "100.0",
      "4100": "0.0",
      "4900": "0.0",
      "5000": "0.0",
      "6000": "15.0",
      "6100": "0.0",
      "total:income": "100.0",
      "total:gain": "0.0",
      "total:expense": "15.0",
      "total:revenue": "100.0",
      "total:netIncome": "85.0",
    });
    // The comparison and the change are amounts, and they are what they were.
    const advertising = report.profitAndLoss.rows.find((row) => row.code === "6000");
    expect(advertising?.amount).toBe("60.00");
    expect(advertising?.comparative).toBe("60.00");
    expect(advertising?.change).toBe("0.00");
    expect(report.warnings).toEqual([]);
  });

  test("a comparison period with no income has no share, and the period shown still has its own", () => {
    // March 2026: Sales 200.00, Advertising 60.00 (30.0). March 2025: Advertising 60.00 and no sales.
    const state = bookOf([
      ["2026-03-05", "4000", 20_000n],
      ["2026-03-06", "6000", 6_000n],
      ["2025-03-06", "6000", 6_000n],
    ]).state;
    const report = compileReports(state, MARCH.asOf, {
      from: MARCH.from,
      compare: "previousYear",
      share: "income",
    });
    expect(sharesOf(report)["6000"]).toBe("30.0");
    expect(sharesOf(report)["total:netIncome"]).toBe("70.0");
    expect(
      [...report.profitAndLoss.rows, ...report.profitAndLoss.totals].some(
        (line) => "comparativeShare" in line,
      ),
    ).toBe(false);
    expect(report.warnings.map((warning) => warning.code)).toEqual([
      "comparison_share_unavailable",
    ]);
    expect(report.warnings[0]?.message).toContain("comparison period");
  });

  test("a comparison that is not available leaves no share for it, and no second warning", () => {
    // The book's calendar begins on 2025-01-01, so a year before March 2025 is outside it.
    const state = bookOf([
      ["2025-03-05", "4000", 20_000n],
      ["2025-03-06", "6000", 6_000n],
    ]).state;
    const report = compileReports(state, "2025-03-31", {
      from: "2025-03-01",
      compare: "previousYear",
      share: "income",
    });
    expect(report.comparison).toBeNull();
    expect(sharesOf(report)["6000"]).toBe("30.0");
    expect(report.warnings.map((warning) => warning.code)).toEqual(["comparison_unavailable"]);
  });

  test("the largest amounts the format allows keep every digit", () => {
    // Sales 9,999,999,999,999,999.99 (D = 999,999,999,999,999,999 cents). Advertising 9,994,999,999,999,999.99:
    // one cent short of the tie, so 99.9 and not the 100.0 a float gives. Rent 0.01: 0.0.
    // Total expenses 9,995,000,000,000,000.00 = 999,500,000,000,000,000 cents, past the tie: 100.0.
    // Net income D - 999,500,000,000,000,000 = 499,999,999,999,999 cents, 4,999,999,999,999.99 dollars.
    // Times 1,000 that is 499,999,999,999,999,000, under D, and twice it, 999,999,999,999,998,000, is 1,999
    // short of D: under half a tenth, so 0.0.
    const state = bookOf([
      ["2026-03-05", "4000", 999_999_999_999_999_999n],
      ["2026-03-06", "6000", 999_499_999_999_999_999n],
      ["2026-03-07", "6100", 1n],
    ]).state;
    const report = compileReports(state, MARCH.asOf, { from: MARCH.from, share: "income" });
    expect(report.profitAndLoss.netIncome).toBe("4999999999999.99");
    const shares = sharesOf(report);
    expect(shares["4000"]).toBe("100.0");
    expect(shares["6000"]).toBe("99.9");
    expect(shares["6100"]).toBe("0.0");
    expect(shares["total:expense"]).toBe("100.0");
    expect(shares["total:netIncome"]).toBe("0.0");
  });

  test("an income past 64 bits is still exact", () => {
    // Ten postings of D to Sales: 9,999,999,999,999,999,990 cents, which is 99,999,999,999,999,999.90 dollars.
    // Advertising is exactly half of it, 4,999,999,999,999,999,995 cents: 500 tenths = 50.0%, and the
    // net income, the other half, is 50.0% too. Times 1,000 these are past 2^64, which a float cannot hold.
    const lines: [string, string, bigint][] = [];
    for (let index = 0; index < 10; index++)
      lines.push([
        `2026-03-${String(5 + index).padStart(2, "0")}`,
        "4000",
        999_999_999_999_999_999n,
      ]);
    lines.push(["2026-03-20", "6000", 4_999_999_999_999_999_995n]);
    const report = compileReports(bookOf(lines).state, MARCH.asOf, {
      from: MARCH.from,
      share: "income",
    });
    expect(report.profitAndLoss.totals.find((total) => total.key === "income")?.amount).toBe(
      "99999999999999999.90",
    );
    const shares = sharesOf(report);
    expect(shares["4000"]).toBe("100.0");
    expect(shares["6000"]).toBe("50.0");
    expect(shares["total:netIncome"]).toBe("50.0");
  });

  test("a reply that is not asked for a share is what it always was", () => {
    const state = bookOf([
      ["2026-03-05", "4000", 20_000n],
      ["2026-03-06", "6000", 6_000n],
      ["2025-03-05", "4000", 40_000n],
    ]).state;
    for (const compare of [undefined, "previousPeriod", "previousYear"] as const) {
      const options = { from: MARCH.from, ...(compare ? { compare } : {}) };
      const plain = compileReports(state, MARCH.asOf, options);
      const none = compileReports(state, MARCH.asOf, { ...options, share: "none" });
      expect(JSON.stringify(none)).toBe(JSON.stringify(plain));
      expect(carriesAShare(plain)).toBe(false);
      expect(JSON.stringify(plain)).not.toContain("hare");
    }
  });

  test("shares added to a reply take nothing else from it", () => {
    const state = bookOf([
      ["2026-03-05", "4000", 20_000n],
      ["2026-03-06", "6000", 6_000n],
      ["2025-03-05", "4000", 40_000n],
    ]).state;
    const plain = compileReports(state, MARCH.asOf, { from: MARCH.from, compare: "previousYear" });
    const asked = compileReports(state, MARCH.asOf, {
      from: MARCH.from,
      compare: "previousYear",
      share: "income",
    });
    const stripped = JSON.parse(JSON.stringify(asked), (key, value) =>
      key === "share" || key === "comparativeShare" ? undefined : value,
    );
    expect(stripped).toEqual(JSON.parse(JSON.stringify(plain)));
    // The statements that are not the profit and loss are untouched, byte for byte.
    expect(JSON.stringify(asked.balanceSheet)).toBe(JSON.stringify(plain.balanceSheet));
    expect(JSON.stringify(asked.trialBalance)).toBe(JSON.stringify(plain.trialBalance));
  });
});

// ---- The file ------------------------------------------------------------------------------------

/** A reader of the file written separately from its writer, enough for cells without line breaks. */
function cells(csv: string): string[][] {
  return csv
    .split("\r\n")
    .filter((line) => line !== "")
    .map((line) => {
      const row: string[] = [];
      let cell = "";
      let quoted = false;
      for (let index = 0; index < line.length; index++) {
        const char = line[index] as string;
        if (quoted) {
          if (char === '"' && line[index + 1] === '"') {
            cell += '"';
            index++;
          } else if (char === '"') quoted = false;
          else cell += char;
        } else if (char === '"') quoted = true;
        else if (char === ",") {
          row.push(cell);
          cell = "";
        } else cell += char;
      }
      row.push(cell);
      return row;
    });
}

const request = (extra: Partial<ExportRequest> = {}): ExportRequest => ({
  statement: "profit-loss",
  asOf: MARCH.asOf,
  from: MARCH.from,
  bookName: "Share Co",
  tags: tagMap({}),
  ...extra,
});

describe("the file with shares of income", () => {
  const comparing = () =>
    bookOf([
      ["2026-03-05", "4000", 20_000n],
      ["2026-03-06", "6000", 6_000n],
      ["2025-03-05", "4000", 40_000n],
      ["2025-03-06", "6000", 6_000n],
    ]).state;

  test("a share column follows the amount, and each comparison column is followed by its own", () => {
    const rows = cells(
      exportStatement(comparing(), request({ compare: "previousYear", share: "income" })).content,
    );
    const head = rows.findIndex((row) => row[0] === "Account ID");
    expect(rows[head]).toEqual([
      "Account ID",
      "Code",
      "Account",
      "Type",
      "Amount",
      "% of income",
      "Comparative",
      "Comparative % of income",
      "Change",
    ]);
    const advertising = rows.find((row) => row[1] === "6000");
    // 60.00, 60 / 200 = 30.0, the year before 60.00, 60 / 400 = 15.0, and a change of nothing.
    expect(advertising?.slice(4)).toEqual(["60.00", "30.0", "60.00", "15.0", "0.00"]);
    // Net income 140.00 of 200.00 is 70.0; 340.00 of 400.00 is 85.0; the change is -200.00.
    expect(rows.find((row) => row[2] === "Net income")?.slice(4)).toEqual([
      "140.00",
      "70.0",
      "340.00",
      "85.0",
      "-200.00",
    ]);
    // Total income is all of itself in both.
    expect(rows.find((row) => row[2] === "Total income")?.slice(4)).toEqual([
      "200.00",
      "100.0",
      "400.00",
      "100.0",
      "-200.00",
    ]);
  });

  test("without a comparison the file has one share column, and without a share request none", () => {
    const withShare = cells(exportStatement(comparing(), request({ share: "income" })).content);
    expect(withShare.find((row) => row[0] === "Account ID")).toEqual([
      "Account ID",
      "Code",
      "Account",
      "Type",
      "Amount",
      "% of income",
    ]);
    const plain = exportStatement(comparing(), request()).content;
    const none = exportStatement(comparing(), request({ share: "none" })).content;
    expect(none).toBe(plain);
    expect(plain).not.toContain("% of income");
    expect(cells(plain).find((row) => row[0] === "Account ID")).toEqual([
      "Account ID",
      "Code",
      "Account",
      "Type",
      "Amount",
    ]);
  });

  test("with no income the columns are there and empty, and the file says why", () => {
    const state = bookOf([["2026-03-06", "6000", 6_000n]]).state;
    const file = exportStatement(state, request({ share: "income" })).content;
    const rows = cells(file);
    expect(rows.find((row) => row[0] === "Account ID")).toEqual([
      "Account ID",
      "Code",
      "Account",
      "Type",
      "Amount",
      "% of income",
    ]);
    expect(rows.find((row) => row[1] === "6000")?.slice(4)).toEqual(["60.00", ""]);
    const warning = rows.find((row) => row[0] === "Warning");
    expect(warning?.[1]).toContain("no income");
  });

  test("a file asked for a share on a statement that has none is refused, not changed", () => {
    for (const statement of [
      "trial-balance",
      "balance-sheet",
      "cash-flow",
      "general-ledger",
    ] as const) {
      const error = failure(() =>
        exportStatement(comparing(), request({ statement, share: "income" })),
      );
      expect(error.code, statement).toBe("invalid_input");
      expect(error.status).toBe(400);
      expect(error.message).toContain("profit and loss");
    }
    // Asking for none is not asking for anything.
    expect(() =>
      exportStatement(comparing(), request({ statement: "balance-sheet", share: "none" })),
    ).not.toThrow();
  });

  test("hostile account names stay text and the share cells stay numbers", () => {
    const accounts: AccountSpec[] = [
      { code: "1000", role: "asset", name: "Cash" },
      { code: "4000", role: "income", name: '=HYPERLINK("http://evil.example","Sales")' },
      { code: "6000", role: "expense", name: '+Ads, "quoted"' },
    ];
    const book = new KernelBook({ firstYear: 2025, years: 2, accounts });
    book.post("2026-03-05", [
      ["1000", 20_000n],
      ["4000", -20_000n],
    ]);
    book.post("2026-03-06", [
      ["6000", 6_000n],
      ["1000", -6_000n],
    ]);
    const rows = cells(exportStatement(book.state, request({ share: "income" })).content);
    const sales = rows.find((row) => row[1] === "4000");
    const ads = rows.find((row) => row[1] === "6000");
    expect(sales?.[2]).toBe('\'=HYPERLINK("http://evil.example","Sales")');
    expect(ads?.[2]).toBe('\'+Ads, "quoted"');
    expect(sales?.[5]).toBe("100.0");
    expect(ads?.[5]).toBe("30.0");
    // A share cell is only ever digits, a point and a minus sign.
    for (const row of rows.slice(rows.findIndex((r) => r[0] === "Account ID") + 1))
      if (row.length > 5 && row[5] !== "") expect(row[5]).toMatch(/^-?(0|[1-9][0-9]*)\.[0-9]$/);
  });
});

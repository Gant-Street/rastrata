import { expect, test } from "bun:test";
import { barHeight, niceTop, tallest } from "../src/home-scale";

test("the top of the scale is an easy number at or above the tallest bar", () => {
  // In cents: 41.70 dollars up to 4,170.00 dollars.
  expect(niceTop(4170_00n)).toBe(5000_00n);
  expect(niceTop(1000_00n)).toBe(1000_00n);
  expect(niceTop(1000_01n)).toBe(2000_00n);
  expect(niceTop(2600_00n)).toBe(4000_00n);
  expect(niceTop(4100_00n)).toBe(5000_00n);
  expect(niceTop(5500_00n)).toBe(8000_00n);
  expect(niceTop(8100_00n)).toBe(10000_00n);
  expect(niceTop(123456_78n)).toBe(200000_00n);
  expect(niceTop(9_00n)).toBe(10_00n);
});

test("a figure is rounded up to a whole dollar for the scale, and nothing draws nothing", () => {
  expect(niceTop(0n)).toBe(100n);
  expect(niceTop(1n)).toBe(100n);
  expect(niceTop(101n)).toBe(200n);
});

test("the half way line of the scale is a whole figure for the sizes a book is likely to have", () => {
  for (const cents of [1_00n, 3_00n, 41_70n, 410_00n, 4170_00n, 52000_00n, 99999_99n]) {
    const top = niceTop(cents);
    expect(top >= cents).toBe(true);
    // Sizes of a dollar or two have a half way of fifty cents; from ten dollars up it is whole.
    if (top >= 10_00n) expect(top % 200n).toBe(0n);
  }
});

test("a bar's height is its share of the top, to a tenth of a percent, and exact", () => {
  expect(barHeight("2500.00", 5000_00n)).toBe(50);
  expect(barHeight("4170.00", 5000_00n)).toBe(83.4);
  expect(barHeight("0.01", 5000_00n)).toBe(0);
  expect(barHeight("5000.00", 5000_00n)).toBe(100);
  // Never taller than the plot.
  expect(barHeight("9000.00", 5000_00n)).toBe(100);
});

test("a missing, zero or negative amount has no bar: the table says what it was", () => {
  expect(barHeight(null, 5000_00n)).toBe(0);
  expect(barHeight("0.00", 5000_00n)).toBe(0);
  expect(barHeight("-120.50", 5000_00n)).toBe(0);
});

test("the tallest figure is the largest of any month, in or out, and negatives and gaps count for nothing", () => {
  expect(
    tallest([
      { income: "1200.00", expenses: "300.00" },
      { income: null, expenses: null },
      { income: "-50.00", expenses: "2682.44" },
    ]),
  ).toBe(2682_44n);
  expect(tallest([])).toBe(0n);
  expect(tallest([{ income: "0.00", expenses: "0.00" }])).toBe(0n);
});

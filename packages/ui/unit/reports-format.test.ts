import { describe, expect, test } from "bun:test";
import {
  amountCents,
  amountDifference,
  centsAmount,
  formatAmount,
  isNegativeAmount,
  parseAmount,
} from "../src/reports/format";

describe("showing an amount", () => {
  test("groups digits and keeps exactly two decimals", () => {
    expect(formatAmount("0.00")).toBe("0.00");
    expect(formatAmount("5.07")).toBe("5.07");
    expect(formatAmount("999.99")).toBe("999.99");
    expect(formatAmount("1000.00")).toBe("1,000.00");
    expect(formatAmount("1150.50")).toBe("1,150.50");
    expect(formatAmount("1234567.89")).toBe("1,234,567.89");
  });

  test("a negative figure has a real minus sign, never a hyphen or parentheses", () => {
    expect(formatAmount("-0.01")).toBe("\u22120.01");
    expect(formatAmount("-1150.00")).toBe("\u22121,150.00");
    expect(isNegativeAmount("-0.01")).toBe(true);
    expect(isNegativeAmount("0.00")).toBe(false);
    expect(isNegativeAmount("12.00")).toBe(false);
  });

  test("a figure past fifteen digits is shown exactly, never rounded through a number", () => {
    expect(formatAmount("1000000000000000.01")).toBe("1,000,000,000,000,000.01");
    expect(formatAmount("9007199254740993.99")).toBe("9,007,199,254,740,993.99");
    expect(formatAmount("-12345678901234567890.12")).toBe("\u221212,345,678,901,234,567,890.12");
    // The number nearest 9007199254740993 is 9007199254740992: a float would have lost the last digit.
    expect(Number("9007199254740993")).toBe(9007199254740992);
  });

  test("the locale decides the separators, and a malformed locale falls back to US English", () => {
    expect(formatAmount("1234567.89", "de-DE")).toBe("1.234.567,89");
    expect(formatAmount("1234.50", "en-GB")).toBe("1,234.50");
    expect(formatAmount("-1234.05", "de-DE")).toBe("\u22121.234,05");
    expect(formatAmount("1234.50", "not a locale")).toBe("1,234.50");
  });

  test("text that is not a wire amount is returned as it is, never guessed", () => {
    for (const text of [
      "",
      "abc",
      "12",
      "12.3",
      "12.345",
      "1,000.00",
      "+5.00",
      "--1.00",
      "01.00",
      "—",
    ])
      expect(formatAmount(text), JSON.stringify(text)).toBe(text);
    expect(parseAmount("12.3")).toBeNull();
    expect(parseAmount("-7.10")).toEqual({ negative: true, whole: "7", cents: "10" });
  });
});

describe("exact arithmetic on wire amounts", () => {
  test("cents round trip, with zero never negative", () => {
    for (const value of [
      "0.00",
      "0.01",
      "-0.01",
      "12.34",
      "-12.34",
      "1000000000000000.01",
      "-9007199254740993.99",
    ])
      expect(centsAmount(amountCents(value)), value).toBe(value);
    expect(centsAmount(0n)).toBe("0.00");
    expect(() => amountCents("12.3")).toThrow(TypeError);
    expect(() => amountCents("")).toThrow(TypeError);
  });

  test("a difference is exact at any size, and zero when the parts add up to the total", () => {
    expect(amountDifference("6800.00", ["80.00", "6720.00"])).toBe("0.00");
    expect(amountDifference("100.00", ["33.33", "33.33", "33.33"])).toBe("0.01");
    expect(amountDifference("0.10", ["0.20"])).toBe("-0.10");
    expect(amountDifference("9007199254740993.00", ["9007199254740992.00", "1.00"])).toBe("0.00");
    expect(amountDifference("5.00", [])).toBe("5.00");
    // The case a float gets wrong: 0.1 + 0.2 is not 0.3 in binary, and here it must be exact.
    expect(amountDifference("0.30", ["0.10", "0.20"])).toBe("0.00");
  });
});

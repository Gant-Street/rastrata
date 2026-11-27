import { expect, test } from "bun:test";
import { amountToCents, amountToMoney } from "../../src/bankfeed/amount.ts";

// A SimpleFIN amount is a "numeric string". It is read exactly or not at all: no float, no rounding.

test("plain decimal strings become exact two-place amounts", () => {
  expect(amountToMoney("12.34")).toBe("12.34");
  expect(amountToMoney("-12.34")).toBe("-12.34");
  expect(amountToMoney("+7.10")).toBe("7.10");
  expect(amountToMoney("12")).toBe("12.00");
  expect(amountToMoney("12.5")).toBe("12.50");
  expect(amountToMoney("0")).toBe("0.00");
  expect(amountToMoney("-0.00")).toBe("0.00");
  expect(amountToMoney(" 3.00 ")).toBe("3.00");
});

test("zeros past the cents change nothing, any other digit there would need rounding", () => {
  expect(amountToMoney("12.340")).toBe("12.34");
  expect(amountToMoney("12.3400000000")).toBe("12.34");
  expect(amountToMoney("12.341")).toBeNull();
  expect(amountToMoney("12.3401")).toBeNull();
  expect(amountToMoney("0.005")).toBeNull();
  expect(amountToMoney("-0.001")).toBeNull();
});

test("a JSON number is refused: by the time it is parsed its digits are gone", () => {
  expect(amountToMoney(12.34)).toBeNull();
  expect(amountToMoney(-0.1)).toBeNull();
  expect(amountToMoney(3)).toBeNull();
  expect(amountToMoney(null)).toBeNull();
  expect(amountToMoney(undefined)).toBeNull();
  expect(amountToMoney({})).toBeNull();
});

test("anything that is not a plain decimal is refused", () => {
  for (const bad of [
    "",
    " ",
    "abc",
    "1e3",
    "1E-2",
    "1,234.50",
    "$12.00",
    "(12.00)",
    "12.00-",
    "--5",
    "+-5",
    ".5",
    "5.",
    "1 2",
    "0x10",
    "NaN",
    "Infinity",
    "12.00 USD",
    "٣.٠٠",
  ])
    expect(amountToMoney(bad)).toBeNull();
});

test("sixteen whole digits do not fit the pipeline's cents and are refused", () => {
  expect(amountToMoney("999999999999999.99")).toBe("999999999999999.99");
  expect(amountToMoney("1000000000000000.00")).toBeNull();
});

test("cents are exact in a bigint at any size, so sums never drift", () => {
  expect(amountToCents("0.10")).toBe(10n);
  expect(amountToCents("0.20")).toBe(20n);
  expect((amountToCents("0.10") ?? 0n) + (amountToCents("0.20") ?? 0n)).toBe(30n);
  expect(amountToCents("-123456789012345.67")).toBe(-12345678901234567n);
});

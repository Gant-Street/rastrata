import { expect, test } from "bun:test";
import { formatMoney } from "../../src/money.ts";
import { parseAmount } from "../../src/statements/amounts.ts";
import { random } from "./helpers.ts";

const ok = (input: string, decimal?: "." | ",") => {
  const result = parseAmount(input, decimal ? { decimal } : {});
  return result.ok ? result.text : `error:${result.error}`;
};

test("the formats banks write all read as exact cents", () => {
  const cases: [string, string][] = [
    ["12.34", "12.34"],
    ["-12.34", "-12.34"],
    ["+12.34", "12.34"],
    ["(12.34)", "-12.34"],
    ["12.34-", "-12.34"],
    ["$12.34", "12.34"],
    ["-$12.34", "-12.34"],
    ["$-12.34", "-12.34"],
    ["($12.34)", "-12.34"],
    ["1,234.50", "1234.50"],
    ["1,234,567.89", "1234567.89"],
    ["$ 1,234.5", "1234.50"],
    ["12", "12.00"],
    ["12.", "12.00"],
    [".5", "0.50"],
    ["0.5", "0.50"],
    ["007.50", "7.50"],
    ["12.34 CR", "12.34"],
    ["12.34 DR", "-12.34"],
    ["12.34CR", "12.34"],
    ["12.340", "12.34"],
    ["12.3400", "12.34"],
    ["USD 12.34", "12.34"],
    ["12.34 USD", "12.34"],
    ["1 234.56", "1234.56"],
    ["1 234.56", "1234.56"],
    ["−12.34", "-12.34"],
    ["  12.34  ", "12.34"],
    ["-0.00", "0.00"],
    ["0", "0.00"],
    ["999999999999999.99", "999999999999999.99"],
  ];
  for (const [input, expected] of cases) expect(ok(input), JSON.stringify(input)).toBe(expected);
});

test("more than two decimals is refused, never rounded", () => {
  for (const input of ["12.345", "0.001", "12.341", "1,234.567", "12.3401"])
    expect(ok(input), input).toBe("error:too_many_decimals");
  // Trailing zeros past the cents change nothing, so they are not a rounding.
  expect(ok("12.3400000")).toBe("12.34");
});

test("text that is not an amount is an error with a reason, not a guess", () => {
  const cases: [string, string][] = [
    ["", "error:empty"],
    ["   ", "error:empty"],
    ["abc", "error:not_a_number"],
    ["1e5", "error:not_a_number"],
    ["--5", "error:not_a_number"],
    ["$", "error:not_a_number"],
    [".", "error:not_a_number"],
    ["12.34.56", "error:bad_grouping"],
    ["12,34", "error:bad_grouping"],
    ["1,2345.00", "error:bad_grouping"],
    ["1,23.00", "error:bad_grouping"],
    ["12 34", "error:bad_grouping"],
    ["1234567890123456.00", "error:too_large"],
    ["NaN", "error:not_a_number"],
    ["Infinity", "error:not_a_number"],
    ["0x10", "error:not_a_number"],
    ["12,", "error:bad_grouping"],
  ];
  for (const [input, expected] of cases) expect(ok(input), JSON.stringify(input)).toBe(expected);
  expect(ok("x".repeat(500))).toBe("error:not_a_number");
  expect(ok(" ".repeat(500))).toBe("error:empty");
});

test("a bank that writes a decimal comma is read when told so, and only then", () => {
  expect(ok("1.234,56", ",")).toBe("1234.56");
  expect(ok("12,34", ",")).toBe("12.34");
  expect(ok("-1.234.567,89", ",")).toBe("-1234567.89");
  expect(ok("12,345", ",")).toBe("error:too_many_decimals");
  expect(ok("12,34")).toBe("error:bad_grouping");
});

test("every amount round-trips through every notation, exactly, at any size", () => {
  const generator = random(7);
  const styles: ((cents: bigint) => string)[] = [
    (cents) => formatMoney(cents),
    (cents) => formatMoney(cents).replace(/\B(?=(\d{3})+(?=\.))/g, ","),
    (cents) => (cents < 0n ? `(${formatMoney(-cents)})` : formatMoney(cents)),
    (cents) => (cents < 0n ? `${formatMoney(-cents)}-` : formatMoney(cents)),
    (cents) => (cents < 0n ? `-$${formatMoney(-cents)}` : `$${formatMoney(cents)}`),
    (cents) => (cents < 0n ? `${formatMoney(-cents)} DR` : `${formatMoney(cents)} CR`),
    (cents) => ` ${formatMoney(cents)} `,
    (cents) => (cents > 0n ? `+${formatMoney(cents)}` : formatMoney(cents)),
  ];
  for (let iteration = 0; iteration < 4000; iteration++) {
    const digits = generator.int(1, 15);
    let magnitude = 0n;
    for (let index = 0; index < digits; index++)
      magnitude = magnitude * 10n + BigInt(generator.int(0, 9));
    const cents = generator.chance(0.5) ? -magnitude : magnitude;
    const style = generator.pick(styles);
    const written = style(cents);
    const parsed = parseAmount(written);
    expect(parsed.ok, written).toBe(true);
    if (parsed.ok) {
      expect(parsed.cents, written).toBe(cents);
      expect(parsed.text).toBe(formatMoney(cents));
      expect(parsed.text).not.toBe("-0.00");
    }
  }
});

test("no input, however odd, throws or yields something that is not money", () => {
  const generator = random(11);
  const alphabet = "0123456789.,-+()$ CRDRcrdr abcxyz\t\n€£";
  for (let iteration = 0; iteration < 5000; iteration++) {
    let text = "";
    for (let index = generator.int(0, 24); index > 0; index--)
      text += alphabet[generator.int(0, alphabet.length - 1)];
    const result = parseAmount(text);
    if (result.ok) expect(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/.test(result.text), text).toBe(true);
  }
});

import { PluginError } from "./errors.ts";

/** Exact integer-cent accounting arithmetic.
 *
 * Rastrata represents money end-to-end as signed two-place decimal strings ("93.31", "-5.00", "0.00")
 * and never uses floating-point arithmetic. All helpers below operate on exact `bigint` minor units. */

const MONEY_PATTERN = /^-?(?:0|[1-9]\d*)\.\d{2}$/;

/** Currencies whose minor unit is 1/100 (two decimal places). Explicitly checked so zero-decimal
 * currencies like JPY are never silently scaled by 100x. */
const TWO_DECIMAL_CURRENCIES = new Set([
  "USD",
  "CAD",
  "EUR",
  "GBP",
  "AUD",
  "NZD",
  "CHF",
  "MXN",
  "SGD",
  "HKD",
  "SEK",
  "NOK",
  "DKK",
]);

/** True when `value` is a canonical signed two-decimal money string (never `"-0.00"`). */
export function isMoney(value: unknown): value is string {
  return typeof value === "string" && MONEY_PATTERN.test(value) && value !== "-0.00";
}

/** Parse a two-decimal money string into exact integer cents. */
export function toCents(value: string, field?: string): bigint {
  if (!MONEY_PATTERN.test(value)) {
    throw new PluginError({
      code: "invalid_money",
      message: `Invalid money string "${value}".`,
      hint: 'Use a signed two-decimal string such as "93.31" or "-5.00" (or convert integer cents with money.fromCents()).',
      ...(field !== undefined ? { field } : {}),
    });
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const dot = unsigned.indexOf(".");
  const dollars = BigInt(unsigned.slice(0, dot));
  const cents = BigInt(unsigned.slice(dot + 1));
  const total = dollars * 100n + cents;
  return negative ? -total : total;
}

/** Format exact integer cents (`bigint` or safe integer `number`) into a canonical money string. */
export function fromCents(cents: bigint | number, field?: string): string {
  let value: bigint;
  if (typeof cents === "bigint") {
    value = cents;
  } else {
    if (!Number.isSafeInteger(cents)) {
      throw new PluginError({
        code: "invalid_money",
        message: `Expected an exact integer number of cents, received ${String(cents)}.`,
        hint: "Pass an integer number of cents (e.g. 9331) or a BigInt (9331n); never pass a floating-point dollar amount.",
        ...(field !== undefined ? { field } : {}),
      });
    }
    value = BigInt(cents);
  }
  if (value === 0n) return "0.00";
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

/** Convert a provider's minor-unit integer (such as Stripe's `amount: 9331` in `"usd"`) into a
 * canonical money string, refusing currencies whose minor unit is not 1/100. */
export function fromMinorUnits(minor: bigint | number, currency: string, field?: string): string {
  const upper = currency.trim().toUpperCase();
  if (!TWO_DECIMAL_CURRENCIES.has(upper)) {
    throw new PluginError({
      code: "invalid_money",
      message: `Currency "${currency}" is not supported by two-decimal minor-unit conversion.`,
      hint: "Rastrata books currently use two-decimal currencies (e.g. USD). Hold foreign or zero-decimal currency items for manual review instead of converting.",
      ...(field !== undefined ? { field } : {}),
    });
  }
  return fromCents(minor, field);
}

/** Negate a money string cleanly (`"-0.00"` is normalized to `"0.00"`). */
export function negate(value: string, field?: string): string {
  return fromCents(-toCents(value, field), field);
}

/** Return the unsigned magnitude of a money string. */
export function abs(value: string, field?: string): string {
  const cents = toCents(value, field);
  return fromCents(cents < 0n ? -cents : cents, field);
}

/** Sum any number of money strings to exact integer cents. */
export function sumCents(values: readonly string[], field?: string): bigint {
  let total = 0n;
  for (const value of values) total += toCents(value, field);
  return total;
}

/** Add any number of money strings and return the formatted total. */
export function add(...values: readonly string[]): string {
  return fromCents(sumCents(values));
}

/** Subtract `b` from `a` and return the formatted difference. */
export function subtract(a: string, b: string): string {
  return fromCents(toCents(a) - toCents(b));
}

export const money = {
  isMoney,
  toCents,
  fromCents,
  fromMinorUnits,
  negate,
  abs,
  sumCents,
  add,
  subtract,
} as const;

/** Exact money arithmetic. The API carries money as decimal strings with exactly two places
 * ("-12.34") and a client never converts one to a JavaScript number. Everything here works on
 * integer cents held in a bigint, so sums are exact at any size. Portable: no dependencies, safe
 * in the browser, the service and a Worker. */
export type Cents = bigint;

const MONEY = /^(-?)(0|[1-9][0-9]*)\.([0-9]{2})$/;

/** True for the wire format: an optional minus, digits, and exactly two decimals. */
export const isMoney = (value: unknown): value is string =>
  typeof value === "string" && MONEY.test(value);

export function parseMoney(value: string): Cents {
  const match = MONEY.exec(value);
  if (!match) throw new TypeError("Money must be a decimal string with exactly two places");
  const cents = BigInt(match[2] as string) * 100n + BigInt(match[3] as string);
  return match[1] === "-" ? -cents : cents;
}

/** Zero is always "0.00", never "-0.00". */
export function formatMoney(cents: Cents): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${absolute / 100n}.${fraction}`;
}

export const addMoney = (a: string, b: string): string =>
  formatMoney(parseMoney(a) + parseMoney(b));
export const subtractMoney = (a: string, b: string): string =>
  formatMoney(parseMoney(a) - parseMoney(b));
export const negateMoney = (a: string): string => formatMoney(-parseMoney(a));
export const absMoney = (a: string): string => {
  const cents = parseMoney(a);
  return formatMoney(cents < 0n ? -cents : cents);
};
export const sumMoney = (values: Iterable<string>): string => {
  let total = 0n;
  for (const value of values) total += parseMoney(value);
  return formatMoney(total);
};
export function compareMoney(a: string, b: string): -1 | 0 | 1 {
  const difference = parseMoney(a) - parseMoney(b);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export const isZeroMoney = (a: string): boolean => parseMoney(a) === 0n;

/** Read an amount a person or a bank typed into the canonical form, or null when it is not an
 * amount. Accepts "1,234.5", "$12", "+7.10", "-7.10", "(7.10)" and "7.10-" (a trailing minus is
 * how some banks write a debit). More than two decimals is refused, never rounded. */
export function normalizeMoney(input: string): string | null {
  let value = input.trim();
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1).trim();
  }
  if (value.endsWith("-")) {
    negative = !negative;
    value = value.slice(0, -1).trim();
  }
  if (value.startsWith("-")) {
    negative = !negative;
    value = value.slice(1).trim();
  } else if (value.startsWith("+")) value = value.slice(1).trim();
  value = value.replace(/^[$€£]\s*/, "");
  if (
    !/^(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)?(?:\.[0-9]{0,2})?$/.test(value) ||
    value === "" ||
    value === "."
  )
    return null;
  const [whole = "", fraction = ""] = value.replaceAll(",", "").split(".");
  const cents = BigInt(whole || "0") * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  return formatMoney(negative ? -cents : cents);
}

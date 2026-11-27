import { formatMoney, type Cents } from "../money.ts";

/** Reading the amount a bank wrote in one cell into exact cents.
 *
 * The rules are the product's rules for money: exact decimals only, never a float, and an amount
 * with more precision than cents is refused, not rounded. Trailing zeros past the cents ("12.340")
 * change nothing and are accepted; any other digit there is an error. */

export type AmountError =
  | "empty"
  | "not_a_number"
  | "too_many_decimals"
  | "bad_grouping"
  | "too_large";

export type AmountResult =
  | { readonly ok: true; readonly cents: Cents; readonly text: string }
  | { readonly ok: false; readonly error: AmountError };

export interface AmountOptions {
  /** The character that separates the cents. A US bank writes "."; many European banks write ",". */
  readonly decimal?: "." | ",";
}

const MAX_DIGITS = 15;

const CURRENCY_SYMBOLS = new Set(["$", "€", "£", "¥", "US$", "USD", "EUR", "GBP"]);

function strip(text: string): string {
  return text
    .replace(/[     ]/g, " ")
    .replace(/[−‒–—]/g, "-")
    .trim();
}

/** Read one amount cell. Accepts "1234.5", "$1,234.50", "(12.30)", "-12.30", "+12.30", "12.30-",
 * "12.30 CR" and "12.30 DR" (a debit is negative), and a leading or trailing currency symbol. */
export function parseAmount(input: string, options: AmountOptions = {}): AmountResult {
  const decimal = options.decimal ?? ".";
  const thousands = decimal === "." ? "," : ".";
  // Bound the work before doing any: a cell is attacker-controlled text of any length.
  if (input.length > 200)
    return { ok: false, error: input.trim() === "" ? "empty" : "not_a_number" };
  let value = strip(input);
  if (value === "") return { ok: false, error: "empty" };
  if (value.length > 40) return { ok: false, error: "not_a_number" };
  // The sign may be written in one way only: a leading or trailing minus or plus, parentheses, or
  // a trailing CR or DR. Two ways at once ("--5", "(-5)", "5- DR") is not an amount anyone meant.
  let negative = false;
  let signs = 0;

  // A trailing "CR" or "DR", as some card statements write a balance or an amount.
  const suffix = /\s*(CR|DR|Cr|Dr|cr|dr)$/.exec(value);
  if (suffix) {
    const marker = (suffix[1] as string).toUpperCase();
    signs++;
    if (marker === "DR") negative = true;
    value = value.slice(0, suffix.index).trim();
  }
  if (value.startsWith("(") && value.endsWith(")")) {
    signs++;
    negative = true;
    value = value.slice(1, -1).trim();
  }
  if (value.endsWith("-") || value.endsWith("+")) {
    signs++;
    if (value.endsWith("-")) negative = true;
    value = value.slice(0, -1).trim();
  }
  const leading = (): void => {
    if (value.startsWith("-") || value.startsWith("+")) {
      signs++;
      if (value.startsWith("-")) negative = true;
      value = value.slice(1).trim();
    }
  };
  leading();
  // A currency symbol or code on either side, then possibly a sign after it ("$-12.30").
  for (const symbol of CURRENCY_SYMBOLS) {
    if (value.startsWith(symbol)) {
      value = value.slice(symbol.length).trim();
      break;
    }
    if (value.endsWith(symbol)) {
      value = value.slice(0, -symbol.length).trim();
      break;
    }
  }
  leading();
  if (signs > 1) return { ok: false, error: "not_a_number" };
  if (value === "" || value === "." || value === ",") return { ok: false, error: "not_a_number" };

  // Split at the decimal character, if there is one.
  const pointAt = value.lastIndexOf(decimal);
  let whole = pointAt === -1 ? value : value.slice(0, pointAt);
  let fraction = pointAt === -1 ? "" : value.slice(pointAt + 1);
  if (pointAt !== -1 && value.indexOf(decimal) !== pointAt) {
    // Two decimal characters. "1.234.567" in a "." locale is not an amount.
    return { ok: false, error: "bad_grouping" };
  }
  if (!/^[0-9]*$/.test(fraction)) return { ok: false, error: "not_a_number" };
  if (whole.includes(thousands) || whole.includes(" ") || whole.includes("'")) {
    // Digit grouping: "1,234,567" or "1 234 567". Groups of exactly three after the first.
    const separator = whole.includes(thousands) ? thousands : whole.includes(" ") ? " " : "'";
    const groups = whole.split(separator);
    const first = groups[0] as string;
    if (!/^[0-9]{1,3}$/.test(first) || !groups.slice(1).every((group) => /^[0-9]{3}$/.test(group)))
      return { ok: false, error: "bad_grouping" };
    whole = groups.join("");
  }
  if (!/^[0-9]*$/.test(whole)) return { ok: false, error: "not_a_number" };
  if (whole === "" && fraction === "") return { ok: false, error: "not_a_number" };
  if (fraction.length > 2) {
    if (/[1-9]/.test(fraction.slice(2))) return { ok: false, error: "too_many_decimals" };
    fraction = fraction.slice(0, 2);
  }
  // Leading zeros are harmless ("007.50"); an enormous number is not.
  whole = whole.replace(/^0+(?=[0-9])/, "");
  if (whole.length > MAX_DIGITS) return { ok: false, error: "too_large" };
  const magnitude = BigInt(whole === "" ? "0" : whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  const cents = negative ? -magnitude : magnitude;
  return { ok: true, cents, text: formatMoney(cents) };
}

/** A short, plain-language reason for an amount that could not be read. */
export function amountProblem(error: AmountError): string {
  switch (error) {
    case "empty":
      return "is empty";
    case "too_many_decimals":
      return "has more than two decimal places, which are never rounded";
    case "bad_grouping":
      return "has thousands separators in the wrong places";
    case "too_large":
      return "is too large";
    default:
      return "is not an amount";
  }
}

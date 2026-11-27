/** Stripe amounts are integers in a currency's smallest unit. The book carries money as decimal
 * strings with exactly two places, so a conversion either is exact or does not happen: there is no
 * rounding anywhere in this lane. Portable: no dependencies beyond money.ts. */

/** Zero-decimal currencies, from Stripe's "Supported currencies" page (checked 2026-10-03).
 * ISK and UGX are deliberately absent: Stripe still represents them with two decimals, always
 * ".00", so their amounts are already in hundredths. */
const ZERO_DECIMAL: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/** Three-decimal currencies per ISO 4217. Stripe's current currency page does not list them, so this
 * set follows ISO 4217 and treats an amount that is not a whole number of hundredths as unusable
 * rather than rounding it. */
const THREE_DECIMAL: ReadonlySet<string> = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export type CurrencyExponent = 0 | 2 | 3;

export function currencyExponent(currency: string): CurrencyExponent {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** A Stripe minor-unit integer expressed in hundredths of the major unit, exactly, or null when it
 * cannot be written with two decimals without rounding. */
export function minorToCents(minor: bigint, currency: string): bigint | null {
  switch (currencyExponent(currency)) {
    case 0:
      return minor * 100n;
    case 2:
      return minor;
    case 3:
      return minor % 10n === 0n ? minor / 10n : null;
  }
}

/** The ISO 4217 code Stripe sends in lower case ("usd"), upper-cased, or null when it is not three
 * letters. */
export function isoCurrency(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
}

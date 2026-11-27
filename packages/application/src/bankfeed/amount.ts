import { formatMoney } from "../money.ts";

/** A SimpleFIN amount ("numeric string") written exactly in hundredths, as the wire format
 * Rastrata uses everywhere (`-12.34`), or null when it cannot be.
 *
 * Only a plain decimal string is read: an optional sign, digits, and an optional fraction. A JSON
 * number is refused, because by the time it has been parsed it is a float and its digits are gone.
 * A third decimal is accepted only when it is zero (`12.340` is exactly 12.34); anything else would
 * need rounding, which this code never does, so the amount is unreadable and the caller says so.
 * More than fifteen whole digits is refused: it would not fit the pipeline's signed 64-bit cents. */
const DECIMAL = /^([+-]?)([0-9]{1,15})(?:\.([0-9]{1,30}))?$/;

export function amountToCents(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) return null;
  const cents = BigInt(match[2] as string) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  return match[1] === "-" ? -cents : cents;
}

/** The same, as a two-place wire amount ("-12.34"), or null. Zero is "0.00", never "-0.00". */
export function amountToMoney(value: unknown): string | null {
  const cents = amountToCents(value);
  return cents === null ? null : formatMoney(cents);
}

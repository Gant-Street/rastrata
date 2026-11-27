/** Reading what a person types into an amount field, exactly: whole cents in a bigint, no number involved,
 * so nothing rounds and more than two decimals is refused rather than cut. Showing an amount is the
 * shared formatter's job (`../format`). */

/** "12.30", "12.3", "12", "1,234.50" and "$5" read as cents; anything else, including a third
 * decimal, a minus sign or an empty string, is null. */
export function parseAmount(text: string): bigint | null {
  const value = text.trim().replace(/^\$/, "").replaceAll(",", "");
  const match = /^(\d*)(?:\.(\d{0,2}))?$/.exec(value);
  if (!match || value === "" || value === ".") return null;
  const whole = match[1] ?? "";
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return BigInt(whole === "" ? "0" : whole) * 100n + BigInt(fraction === "" ? "0" : fraction);
}

/** The text of a wire amount without its minus sign, for a column that says which way the money went. */
export const withoutSign = (amount: string): string =>
  amount.startsWith("-") ? amount.slice(1) : amount;

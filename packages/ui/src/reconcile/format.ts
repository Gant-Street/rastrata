/** Reading aids for the lines of a statement. Showing an amount is the shared formatter's job
 * (`../format`); this only works on the wire text, so nothing here can round. */

export const withoutSign = (amount: string): string =>
  amount.startsWith("-") ? amount.slice(1) : amount;

/** Does a typed search match a line? Text matches the description anywhere; digits match the start
 * of the amount, so "40" and "40.1" narrow down to "40.10" as the person types. */
export function lineMatches(line: { description: string; amount: string }, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  if (line.description.toLowerCase().includes(text)) return true;
  const digits = text.replace(/[$,\s]/g, "").replace(/^[-+]/, "");
  return /^\d+(\.\d*)?$/.test(digits) && withoutSign(line.amount).startsWith(digits);
}

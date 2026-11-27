/** The scale of "Money in and out": where the top of the plot is, and how tall each bar stands. Pure
 * and exact: integer cents in a bigint, so a bar is never drawn from a rounded figure, and the scale is
 * the one place a figure is rounded (up, to an easy number). */
import { moneyToCents } from "./format";

/** The top of the scale for the tallest bar: a whole, easy number (1, 2, 4, 5, 8 or 10 times a power of
 * ten) at or above it, in cents, so the lines of the grid read as 0, half and the top. */
export function niceTop(cents: bigint): bigint {
  const units = (cents + 99n) / 100n;
  if (units <= 0n) return 100n;
  const magnitude = 10n ** BigInt(String(units).length - 1);
  for (const factor of [1n, 2n, 4n, 5n, 8n, 10n]) {
    const candidate = factor * magnitude;
    if (candidate >= units) return candidate * 100n;
  }
  return 10n * magnitude * 100n;
}

/** How tall a bar is, as a share of the plot, in percent to one decimal. A negative or missing amount
 * has no bar: the table says what it was. */
export function barHeight(amount: string | null, top: bigint): number {
  if (amount === null) return 0;
  const cents = moneyToCents(amount);
  if (cents <= 0n) return 0;
  const tenths = (cents * 1000n) / top;
  return Number(tenths > 1000n ? 1000n : tenths) / 10;
}

/** The largest figure in the months, in cents; negative figures draw nothing and so count for nothing. */
export function tallest(
  months: readonly { readonly income: string | null; readonly expenses: string | null }[],
): bigint {
  let most = 0n;
  for (const month of months)
    for (const amount of [month.income, month.expenses]) {
      if (amount === null) continue;
      const cents = moneyToCents(amount);
      if (cents > most) most = cents;
    }
  return most;
}

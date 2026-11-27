/** Reading aids for the rules screens' ratios. Showing money and counts is the shared formatter's
 * job (`../format`). */
import { formatCount } from "../format";

/** A whole percentage, rounded down, or null when there is nothing to divide by. */
export function percentOfCounts(part: number, whole: number): number | null {
  return whole > 0 ? Math.floor((part * 100) / whole) : null;
}

/** Hundredths of a percent as one decimal place, rounded down: 9231 is "92.3%". */
export function basisText(basisPoints: number | null): string {
  if (basisPoints === null) return "—";
  const tenths = Math.floor(basisPoints / 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** Plain-language "12 of 40" for an exact ratio. */
export const ratioText = (numerator: number, denominator: number): string =>
  `${formatCount(numerator)} of ${formatCount(denominator)}`;

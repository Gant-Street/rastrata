/** What every tax operation reads the same way: the tax year (only the years whose forms were
 * verified), the range it covers, the tags (pinned to a recorded revision when asked) and the day the
 * books start. */
import { readAccountTags, type AccountTagMap } from "../../account-tags.ts";
import { TAX_YEARS } from "../../chart/tax-lines.ts";
import { ApplicationError } from "../../errors.ts";
import { isDate } from "../../reports/dates.ts";
import type { ApplicationService } from "../../service.ts";

const yearsText = () => TAX_YEARS.join(" and ");

/** A tax year the verified catalog covers. Asking for another is an error, never a silent nearest
 * year: line numbers and thresholds differ between years, so the wrong year is the wrong rule. */
export function coveredTaxYear(value: unknown): number {
  if (typeof value === "number" && TAX_YEARS.includes(value)) return value;
  throw new ApplicationError(
    "tax_year_unsupported",
    `Rastrata has verified the IRS forms and rules for ${yearsText()}. Line numbers and reporting thresholds differ between years, so choose one of those years.`,
    400,
    [{ path: "input.taxYear", message: `Supported: ${yearsText()}` }],
  );
}

export interface TaxRange {
  readonly taxYear: number;
  readonly from: string;
  readonly to: string;
}

/** The tax year and the dates it covers: 1 January to 31 December unless the caller says
 * otherwise (a fiscal-year partnership or S corporation). */
export function taxRange(input: Record<string, unknown>): TaxRange {
  const taxYear = coveredTaxYear(input.taxYear);
  const from = typeof input.from === "string" ? input.from : `${taxYear}-01-01`;
  const to = typeof input.to === "string" ? input.to : `${taxYear}-12-31`;
  for (const [field, value] of [
    ["from", from],
    ["to", to],
  ] as const)
    if (!isDate(value))
      throw new ApplicationError(
        "invalid_input",
        `${field} must be a real date (YYYY-MM-DD)`,
        400,
        [{ path: `input.${field}`, message: "Expected a real calendar date" }],
      );
  if (from > to)
    throw new ApplicationError("invalid_input", "from must not be after to", 400, [
      { path: "input.from", message: `${from} is after ${to}` },
    ]);
  return { taxYear, from, to };
}

export const revisionOf = (input: Record<string, unknown>): bigint | undefined =>
  typeof input.revision === "string" ? BigInt(input.revision) : undefined;

/** The account tags, read once from product state and passed to the pure compilers. A recorded tag
 * revision pins them, so a worksheet at a pinned book revision reproduces after tags change. */
export const tagsOf = (
  service: ApplicationService,
  input: Record<string, unknown>,
): AccountTagMap =>
  readAccountTags(
    service.store,
    typeof input.tagsRevision === "string" ? { throughRevision: Number(input.tagsRevision) } : {},
  );

/** The first day the books hold, when a cutover date is recorded (the shadow lane keeps it in its own
 * log). Activity before it is in the owner's earlier system, not in Rastrata, and a tax figure for a
 * range that starts earlier must say so. Null when no date is recorded or the lane has recorded
 * none. */
export function booksStartOn(service: ApplicationService): string | null {
  const store = service.store;
  const table = store
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='shadow_cutover_log'")
    .get();
  if (!table) return null;
  const row = store
    .query("SELECT cutover_on FROM shadow_cutover_log ORDER BY seq DESC LIMIT 1")
    .get() as { cutover_on: string } | null;
  return row && isDate(row.cutover_on) ? row.cutover_on : null;
}

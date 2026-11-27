import type { ApplicationInputs, ApplicationOutputs } from "@rastrata/application/client-contracts";
import { MAX_MONTH_COLUMNS, monthWindows } from "@rastrata/ui/reports/period";
import type { MonthColumn, MonthlyReports } from "@rastrata/ui/reports/data";

type Core = ApplicationOutputs["reports.get"];
type CoreInput = ApplicationInputs["reports.get"];

/** The dates a by-month report covers, and the book revision a link asked for, if one did. */
export interface MonthlyInput {
  readonly from: string;
  readonly asOf: string;
  readonly revision?: string | undefined;
}

/** One read of the service's `reports.get`. The screen passes the browser client's; a test passes a
 * stand-in. */
export type ReadCore = (input: CoreInput) => Promise<Core>;

/** How many months are asked for at once. The service answers one read at a time against one view of
 * the book, so more at once would only queue; a few at once keeps the first columns coming. */
const AT_ONCE = 4;

/** A report by month: the whole range once, then each month of it, every read at the book revision the
 * whole range was read at. That is the point of reading the total first. Months are separate reads
 * that could otherwise straddle a posting made in another window, and then a column would be of a
 * different book from the next. Pinned to one revision they cannot be, and the screen still checks
 * that the months add up to the total instead of assuming it.
 *
 * Pinning to the revision just read costs nothing: the service holds that view of the book in memory,
 * and a read at its own current revision is answered from it without replaying anything. Only a
 * posting that lands between the first read and the last makes a later read replay (the older book is
 * rebuilt for it), which is the price of every column being the same book.
 *
 * A range with no months, or more than `MAX_MONTH_COLUMNS`, is a mistake of the caller: the screen
 * says why and never asks. */
export async function readMonthly(
  read: ReadCore,
  input: MonthlyInput,
): Promise<MonthlyReports<Core>> {
  const windows = monthWindows({ from: input.from, to: input.asOf });
  if (windows.length === 0 || windows.length > MAX_MONTH_COLUMNS)
    throw new RangeError(`A report by month covers 1 to ${MAX_MONTH_COLUMNS} months.`);
  const total = await read({
    asOf: input.asOf,
    from: input.from,
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
  });
  const revision = total.bookRevision;
  const months: MonthColumn<Core>[] = [];
  for (let start = 0; start < windows.length; start += AT_ONCE) {
    const batch = windows.slice(start, start + AT_ONCE);
    const reads = await Promise.all(
      batch.map((window) => read({ asOf: window.to, from: window.from, revision })),
    );
    for (const [index, window] of batch.entries())
      months.push({
        month: window.month,
        from: window.from,
        to: window.to,
        partial: window.partial,
        endsMonth: window.endsMonth,
        data: reads[index] as Core,
      });
  }
  return { total, months };
}

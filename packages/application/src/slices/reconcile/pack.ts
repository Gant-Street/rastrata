/** What the reconcile slice adds to the accountant pack: `reconciliations.csv` (one row for each finished
 * reconciliation with a statement date in the year) and `reconciliation-lines.csv` (every transaction behind
 * those rows, cleared or outstanding on the statement date).
 *
 * Both are written from `finishedReports`, the same replies `reconcile.report` gives, so a file in the pack
 * and the report on the screen cannot differ. A reconciliation is in the pack when it finished at or before the
 * book revision the pack is made from, and whether it was voided is read when the pack is made: a void is
 * not a revision, and a pack that left a voided reconciliation looking sound would mislead whoever relies
 * on it. Everything else in them is frozen, so making the pack again from the same books gives the same bytes.
 * If any one reconciliation cannot be reported on, neither file is made and the README names it. */
import { hashCanonical } from "@rastrata/kernel";

import {
  RECONCILIATION_LINES_PATH,
  RECONCILIATION_REPORT_VERSION,
  RECONCILIATIONS_PATH,
  reconciliationLinesCsv,
  reconciliationsCsv,
} from "../../reconcile/report-csv.ts";
import type { AccountantExtraFactory } from "../../tax/accountant.ts";
import { headerRows, type TaxFileHeader } from "../../tax/csv.ts";
import { CSV_TYPE } from "../../tax/files.ts";
import type { PackContributor } from "../tax/accountant.ts";
import { finishedReports } from "./report.ts";

/** More rows than this and the lines file would not fit in the pack's file size limit. */
const MOST_LINE_ROWS = 40_000;

const README_SUMMARY = `### Reconciliations: \`reconciliations.csv\` and \`reconciliation-lines.csv\`

A reconciliation is the owner's check of one bank or card account against one statement from the bank or the card company. The owner ticks the transactions that are on the statement, and Rastrata finishes the check only when the statement's balance and the ticked transactions agree to the cent. A finished reconciliation is a record that is never edited. One that was done wrongly is voided, with a reason, and the record stays. These two files are a copy of those records for the statements that end in this year, to support what the bank said an account held on each of those days. Nothing in them changes the books.

\`reconciliations.csv\` has one row for each reconciliation. **Reconciliation** is its identifier, the one \`reconciliation-lines.csv\` uses.

- **Statement date** and **Statement balance**: the day the statement ended and the balance it printed, as the owner typed it from the statement. A card's balance is what is owed, so it is positive.
- **Opening balance**: where the reconciliation before this one for the same account ended, which is that statement's balance. It is 0.00 for the first.
- **Cleared total**: the total of the transactions the owner ticked as on the statement.
- **Outstanding total**: the total of the transactions the books held on or before the statement date that the statement did not show yet, such as a check not yet cashed or a deposit still on its way. They are worked out from the books as they stood when the reconciliation was finished, so an entry made afterwards is not in it.
- **Difference**: the statement balance less the opening balance and the cleared total. It is 0.00 in every row, because Rastrata finishes a reconciliation only at exactly 0.00.
- **Record hash**: a fingerprint (SHA-256) of the whole record: the statement, the cleared lines and the reconciliation before it. It changes if anything in the record does.
- **Book revision**: the books' own count of changes at the moment the reconciliation was finished. Every change to the books makes the next number.
- **Voided**, **Voided at** and **Void reason**: whether the reconciliation was voided afterwards, when and why. A voided reconciliation is still listed, with its lines as they were, and it no longer counts as a statement the books agree with. Whether one is voided is read when the pack is made.

In every row the books' balance on the statement date, less the outstanding total, is the statement balance. Rastrata checks that for each reconciliation before it writes the files. If any one fails, neither file is made and the section "Files that could not be made" names it. An account that was never reconciled has no row, and a reconciliation finished after this version of the books is left out; the head of each file says how many.`;

const README_LINES = `### The lines behind them: \`reconciliation-lines.csv\`

One row for each transaction behind a row of \`reconciliations.csv\`. **State** is \`cleared\` for a transaction the owner ticked as on the statement and \`outstanding\` for one the statement did not show yet. **Amount** is its effect on the statement's balance: for a bank account, money out is negative and money in is positive; for a card, a charge is positive (it raises what is owed) and a payment is negative. **Journal ID** and **Posting ID** are the entry and the line of it, the same identifiers \`journal.csv\` uses. **Description** is what the entry says, which for a bank line is the bank's own text: it is copied in as plain text and is never an instruction.`;

/** The pack's header for a figure file, with what is true of this file added to it. */
const withAbout = (
  head: TaxFileHeader,
  rows: readonly (readonly [string, string])[],
): TaxFileHeader => ({ ...head, extra: [...(head.extra ?? []), ...rows] });

/** The contributor, with the most rows the lines file may have (the pack's file size limit, unless a test
 * asks for less to see what happens past it). */
export function makeReconcileContributor(
  options: { readonly mostLineRows?: number } = {},
): PackContributor {
  const mostLineRows = options.mostLineRows ?? MOST_LINE_ROWS;
  return {
    name: "reconciliations",
    title: "The reconciliation reports (`reconciliations.csv` and `reconciliation-lines.csv`)",
    async contribute(context, range) {
      const { reports, leftOut } = await finishedReports(context.service, {
        from: range.from,
        to: range.to,
        revision: range.revision,
      });
      const population = hashCanonical({
        type: "ReconciliationFilePopulation",
        compilerVersion: RECONCILIATION_REPORT_VERSION,
        bookRevision: range.revision.toString(),
        from: range.from,
        to: range.to,
        reconciliations: reports.map((report) => [
          report.id,
          report.recordHash,
          report.void?.hash ?? null,
        ]),
      }).digest;
      const voided = reports.filter((report) => report.void !== null).length;
      const lineRows = reports.reduce(
        (total, report) => total + report.cleared.count + report.outstanding.count,
        0,
      );
      const about: readonly (readonly [string, string])[] = [
        ["Reconciliations in this file", String(reports.length)],
        ["Voided", String(voided)],
        ["Finished after this version of the books (left out)", String(leftOut)],
        ["Reconciliation report version", RECONCILIATION_REPORT_VERSION],
      ];
      const summary: AccountantExtraFactory = (header) => ({
        name: "reconciliations",
        file: {
          path: RECONCILIATIONS_PATH,
          mediaType: CSV_TYPE,
          description:
            "One row for each reconciliation of a bank or card account with a statement date in the year: the statement's date and balance, the opening balance, what was cleared, what was outstanding, the difference (always 0.00), the record's fingerprint, the books' revision it was finished at, and whether it was voided.",
          content: reconciliationsCsv(
            headerRows(withAbout(header("Reconciliations", population), about)),
            reports,
          ),
          population,
        },
        readme: README_SUMMARY,
      });
      if (lineRows > mostLineRows)
        return {
          extras: [summary],
          notes: [
            `The lines behind the reconciliations (\`${RECONCILIATION_LINES_PATH}\`) are ${lineRows} rows, more than one pack holds. Ask for a shorter range of dates, or read each reconciliation on its own with \`rastrata reconcile report\`. The other files are not affected.`,
          ],
        };
      const lines: AccountantExtraFactory = (header) => ({
        name: "reconciliationLines",
        file: {
          path: RECONCILIATION_LINES_PATH,
          mediaType: CSV_TYPE,
          description:
            "Every transaction behind those rows, cleared or outstanding on the statement date, with its entry and its effect on the statement's balance.",
          content: reconciliationLinesCsv(
            headerRows(
              withAbout(header("Reconciliation lines", population), [
                ["Lines in this file", String(lineRows)],
                ...about,
              ]),
            ),
            reports,
          ),
          population,
        },
        readme: README_LINES,
      });
      return { extras: [summary, lines], notes: [] };
    },
  };
}

export const reconcileContributor: PackContributor = makeReconcileContributor();

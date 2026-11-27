/** Files the tax lane writes, as data: a path inside a folder or zip, a media type, what it is and its
 * text. The service returns them and the person's own machine writes them (the CLI to a folder or a
 * zip, the browser to a download), so this code stays portable. A file's text is UTF-8. */
import type { BookState } from "@rastrata/kernel";

import type { TaxWorksheet } from "../client-contracts.gen.ts";
import {
  formFileStem,
  worksheetAccountsCsv,
  worksheetCsv,
  worksheetHeader,
  worksheetPostingsCsv,
} from "./csv.ts";
import { analyzeWorksheet, type WorksheetRequest } from "./worksheet.ts";

export const CSV_TYPE = "text/csv; charset=utf-8";

export interface TaxFile {
  /** A relative path with forward slashes, built from fixed words and validated dates. */
  readonly path: string;
  readonly mediaType: string;
  readonly description: string;
  readonly content: string;
  /** The population hash the file was built from, or null for a file that is not a figure. */
  readonly population: string | null;
}

export type WorksheetFileKind = "worksheet" | "accounts" | "postings";

/** The three files of a worksheet: the lines, the accounts behind them, and every posting. */
export function worksheetFiles(
  state: BookState,
  request: WorksheetRequest,
  bookName: string,
  folder = "",
  analysis: ReturnType<typeof analyzeWorksheet> = analyzeWorksheet(state, request),
): { readonly worksheet: TaxWorksheet; readonly files: Record<WorksheetFileKind, TaxFile> } {
  const { worksheet, postings } = analysis;
  const header = worksheetHeader(worksheet, bookName);
  const stem = `${folder}${formFileStem(request.form)}`;
  const name = worksheet.form.name;
  return {
    worksheet,
    files: {
      worksheet: {
        path: `${stem}-worksheet.csv`,
        mediaType: CSV_TYPE,
        description: `${name} worksheet: every line in the order of the form, the reconciliation to the profit and loss, warnings and notes.`,
        content: worksheetCsv(header, worksheet),
        population: worksheet.populationHash,
      },
      accounts: {
        path: `${stem}-accounts.csv`,
        mediaType: CSV_TYPE,
        description: `The accounts behind each ${name} line, and the accounts that are not mapped to any line.`,
        content: worksheetAccountsCsv(header, worksheet),
        population: worksheet.populationHash,
      },
      postings: {
        path: `${stem}-postings.csv`,
        mediaType: CSV_TYPE,
        description: `Every posting behind the ${name} worksheet, with its journal, so any figure can be followed to the entry it came from.`,
        content: worksheetPostingsCsv(header, postings),
        population: worksheet.populationHash,
      },
    },
  };
}

/** The changes file of the accountant pack: what changed in the books, one row for each change, newest
 * first, as a spreadsheet reads it. Every text cell is neutralised (a cell that begins `=`, `+`, `-`
 * or `@` is text, not a formula), money is a plain decimal, and nothing in it is a clock reading: the
 * same book revision and the same product state give the same bytes. Pure and portable. */
import type { ChangeRecord, ChangeSourceStatus } from "../client-contracts.gen.ts";
import { sanitizeText } from "../ingest/text.ts";
import { amount, render, text } from "../reports/csv.ts";
import { type TaxFileHeader, headerRows } from "../tax/csv.ts";
import { NOT_COVERED, NOT_RECORDED } from "./kinds.ts";

export const CHANGES_PATH = "changes.csv";
export const CHANGES_VERSION = "rastrata-changes-v1";

export const CHANGES_COLUMNS = [
  "Revision",
  "Recorded at",
  "Kind",
  "What",
  "Entry date",
  "Amount",
  "Accounts",
  "By",
  "How",
  "Reference",
] as const;

/** Who made a change, as a person reads it in a cell. */
function byWords(by: ChangeRecord["by"]): string {
  if (by.kind === "unknown") return NOT_RECORDED;
  if (by.kind === "owner") return "owner";
  return `${by.kind} ${by.label}`;
}

/** Which sources were read, in words, for the head of the file. */
function sourceLines(
  sources: readonly ChangeSourceStatus[],
): readonly (readonly [string, string])[] {
  const read = sources.filter((source) => source.read).map((source) => source.title);
  const notRead = sources
    .filter((source) => !source.read)
    .map((source) => `${source.title} (${sanitizeText(source.reason ?? "not read", 200)})`);
  // A part a source keeps from this reader (the agent keys, which are the owner's to see) is left out and said.
  const withheld = sources
    .filter((source) => (source.withheld ?? null) !== null)
    .map((source) => `${source.title} (${sanitizeText(source.withheld ?? "", 200)})`);
  return [
    ["Sources read", read.join("; ") || "none"],
    ["Sources not read in full", notRead.join("; ") || "none"],
    ["Left out for this reader", withheld.join("; ") || "none"],
    ["Not covered by this list", NOT_COVERED.join("; ")],
  ];
}

export interface ChangesFileInput {
  readonly changes: readonly ChangeRecord[];
  readonly sources: readonly ChangeSourceStatus[];
  /** The first revision whose maker the book recorded, or null when it never did. */
  readonly attributionFrom: string | null;
  /** From this date (UTC) the changes were recorded. */
  readonly from: string;
}

/** The file's text. `header` is the pack's own header for a figure file, so this one is traced to the
 * book revision it was built from like the others. */
export function changesCsv(header: TaxFileHeader, input: ChangesFileInput): string {
  const rows: string[][] = [CHANGES_COLUMNS.map(text)];
  for (const change of input.changes)
    rows.push([
      change.revision === null ? "" : change.revision,
      text(change.at),
      text(change.kind),
      text(change.summary),
      text(change.entry?.date ?? ""),
      change.entry ? amount(change.entry.amount) : "",
      text(change.entry ? change.entry.accounts.join("; ") : ""),
      text(byWords(change.by)),
      text(change.how),
      text(change.subject.id),
    ]);
  const extra: (readonly [string, string])[] = [
    ["Changes recorded from", input.from],
    [
      "Makers recorded from revision",
      input.attributionFrom === null ? "never" : input.attributionFrom,
    ],
    ...sourceLines(input.sources),
  ];
  return render([
    ...headerRows({ ...header, extra: [...(header.extra ?? []), ...extra] }),
    ...rows,
  ]);
}

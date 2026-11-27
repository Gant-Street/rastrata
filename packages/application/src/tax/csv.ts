/** CSV for the tax lane's files. Bank memos, merchant names and account names are attacker-controlled
 * text, and a spreadsheet runs a cell that begins `=`, `+`, `-` or `@` as a formula, so every text
 * cell goes through the reports lane's neutraliser; a money cell is validated to be a plain decimal
 * and written as is, so negative figures stay numbers. Pure and portable. */
import type { TaxWorksheet } from "../client-contracts.gen.ts";
import { formatMoney } from "../money.ts";
import { amount, render, text } from "../reports/csv.ts";
import type { WorksheetFormId } from "./forms.ts";
import type { WorksheetPostingRow } from "./worksheet.ts";

/** What every tax file states about itself, so a file can be traced to the book revision and the
 * population it came from. */
export interface TaxFileHeader {
  readonly title: string;
  readonly book: string;
  readonly currency: string;
  readonly basis: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly bookRevision: string;
  readonly populationHash: string;
  readonly compilerVersion: string;
  readonly extra?: readonly (readonly [string, string])[];
}

export function headerRows(h: TaxFileHeader): string[][] {
  const rows: string[][] = [
    [text("Report"), text(h.title)],
    [text("Book"), text(h.book)],
    [text("Currency"), text(h.currency)],
    [text("Basis"), text(h.basis)],
    [text("Period start"), text(h.periodStart)],
    [text("Period end"), text(h.periodEnd)],
    [text("Book revision"), text(h.bookRevision)],
    [text("Population hash"), text(h.populationHash)],
    [text("Compiler version"), text(h.compilerVersion)],
  ];
  for (const [key, value] of h.extra ?? []) rows.push([text(key), text(value)]);
  rows.push([]);
  return rows;
}

const FORM_FILE: Readonly<Record<WorksheetFormId, string>> = {
  scheduleC: "schedule-c",
  form1120S: "form-1120-s",
  form1065: "form-1065",
};
/** A file-name stem built only from fixed words, never from book content. */
export const formFileStem = (form: WorksheetFormId): string => FORM_FILE[form];

export function worksheetHeader(worksheet: TaxWorksheet, book: string): TaxFileHeader {
  return {
    title: `${worksheet.form.name} worksheet ${worksheet.taxYear}`,
    book,
    currency: worksheet.currency,
    basis: worksheet.basis,
    periodStart: worksheet.from,
    periodEnd: worksheet.to,
    bookRevision: worksheet.bookRevision,
    populationHash: worksheet.populationHash,
    compilerVersion: worksheet.compilerVersion,
    extra: [
      ["Tax year", String(worksheet.taxYear)],
      ["Form", worksheet.form.name],
      ["Form status", worksheet.form.status === "draft" ? "IRS draft, not final" : "final"],
      ["Ledger population hash", worksheet.ledgerPopulationHash],
      ["Tag map hash", worksheet.tagMapHash],
      ["Tags revision", worksheet.tagsRevision],
      ["Meals percent", String(worksheet.mealsPercent)],
      ["Notice", worksheet.disclaimer],
    ],
  };
}

/** The worksheet: every line in the order of the form, then the reconciliation to the profit and loss,
 * the warnings and the notes, in one table so a spreadsheet can read it. */
export function worksheetCsv(h: TaxFileHeader, worksheet: TaxWorksheet): string {
  const rows: string[][] = [
    ["Part", "Line", "Description", "Kind", "Booked", "On the form", "How figured, or note"].map(
      text,
    ),
  ];
  for (const part of worksheet.parts)
    for (const line of part.lines) {
      const how = [
        line.formula,
        line.adjustment
          ? `${line.adjustment.percent}% taken; ${line.adjustment.removed} removed from the booked cost`
          : undefined,
        line.note,
      ]
        .filter((entry): entry is string => !!entry)
        .join(" ");
      rows.push([
        text(part.label),
        text(line.number),
        text(line.label),
        text(line.kind),
        amount(line.booked),
        amount(line.amount),
        text(how),
      ]);
    }
  rows.push([]);
  for (const row of worksheet.reconciliation.rows)
    rows.push([
      text("Reconciliation to the profit and loss"),
      "",
      text(row.label),
      text("reconciliation"),
      "",
      amount(row.amount),
      "",
    ]);
  rows.push([
    text("Reconciliation to the profit and loss"),
    "",
    text("Net income per the profit and loss, same dates"),
    text("reconciliation"),
    "",
    amount(worksheet.reconciliation.netIncomeBooks),
    "",
  ]);
  rows.push([]);
  for (const warning of worksheet.warnings)
    rows.push([text("Warnings"), "", text(warning.message), text(warning.code), "", "", ""]);
  for (const note of worksheet.notes)
    rows.push([
      text("Notes"),
      "",
      text(note.text),
      text(note.key),
      "",
      "",
      text((note.sources ?? []).map((source) => `${source.title} ${source.url}`).join("; ")),
    ]);
  return render([...headerRows(h), ...rows]);
}

/** The accounts behind each line, and the accounts that are not mapped, one row each. */
export function worksheetAccountsCsv(h: TaxFileHeader, worksheet: TaxWorksheet): string {
  const rows: string[][] = [
    [
      "Status",
      "Line",
      "Line description",
      "Account code",
      "Account",
      "Type",
      "From",
      "To",
      "Postings",
      "Amount",
      "Tax line tag",
    ].map(text),
  ];
  for (const part of worksheet.parts)
    for (const line of part.lines)
      for (const account of line.accounts)
        rows.push([
          text("mapped"),
          text(line.number),
          text(line.label),
          text(account.code),
          text(account.name),
          text(account.role),
          text(account.from),
          text(account.to),
          String(account.postings),
          amount(account.amount),
          text(line.key),
        ]);
  for (const account of worksheet.unmapped)
    rows.push([
      text(`not mapped: ${account.reason}`),
      "",
      "",
      text(account.code),
      text(account.name),
      text(account.role),
      text(account.from),
      text(account.to),
      String(account.postings),
      amount(account.amount),
      text(account.taxLine ?? ""),
    ]);
  return render([...headerRows(h), ...rows]);
}

/** Every posting behind the worksheet, so any figure can be followed to the journal it came from. */
export function worksheetPostingsCsv(
  h: TaxFileHeader,
  rows: readonly WorksheetPostingRow[],
): string {
  const table: string[][] = [
    [
      "Line",
      "Status",
      "Account code",
      "Account",
      "Type",
      "Date",
      "Journal ID",
      "Posting ID",
      "Description",
      "Amount",
    ].map(text),
  ];
  for (const row of rows)
    table.push([
      text(row.lineNumber),
      text(row.status),
      text(row.account.code),
      text(row.account.name),
      text(row.account.role),
      text(row.date),
      text(row.journalId),
      text(row.postingId),
      text(row.narration),
      amount(formatMoney(row.amount)),
    ]);
  return render([...headerRows(h), ...table]);
}

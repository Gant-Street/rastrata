/** CSV for the sales-tax summary. Account names, narrations and Stripe's payout ids are text from
 * outside the product, and a spreadsheet runs a cell that begins `=`, `+`, `-` or `@` as a formula, so
 * every text cell goes through the reports lane's neutraliser; money cells are validated decimals
 * written as is. Pure and portable. */
import type { TaxSalesSummary } from "../client-contracts.gen.ts";
import { formatMoney, parseMoney } from "../money.ts";
import { amount, render, text } from "../reports/csv.ts";
import { headerRows, type TaxFileHeader } from "./csv.ts";
import type { SalesPostingRow } from "./sales.ts";

export function salesHeader(summary: TaxSalesSummary, book: string): TaxFileHeader {
  return {
    title: `Sales tax summary ${summary.taxYear}`,
    book,
    currency: summary.currency,
    basis: summary.basis,
    periodStart: summary.from,
    periodEnd: summary.to,
    bookRevision: summary.bookRevision,
    populationHash: summary.populationHash,
    compilerVersion: summary.compilerVersion,
    extra: [
      ["Tax year", String(summary.taxYear)],
      ["Periods", summary.period],
      ["Accounts", summary.accounts.map((account) => `${account.code} ${account.name}`).join("; ")],
      ["Ledger population hash", summary.ledgerPopulationHash],
      ["Tag map hash", summary.tagMapHash],
      ["Tags revision", summary.tagsRevision],
      ["Statement", summary.statement],
      ["Notice", summary.disclaimer],
    ],
  };
}

const ORIGIN_WORD = {
  stripe: "Stripe payout",
  other: "bank line or entry typed in",
} as const;

/** The periods and their totals, the warnings and the notes, in one table a spreadsheet can read. */
export function salesSummaryCsv(h: TaxFileHeader, summary: TaxSalesSummary): string {
  const rows: string[][] = [
    [
      "Period",
      "From",
      "To",
      "Balance at the start",
      "Tax collected (credits)",
      "Tax paid or returned (debits)",
      "Balance at the end",
      "Postings",
      "Booked from Stripe payouts, net",
      "Reported by Stripe on those payouts, net",
      "Difference",
    ].map(text),
  ];
  for (const period of summary.periods)
    rows.push([
      text(period.key),
      text(period.from),
      text(period.to),
      amount(period.opening),
      amount(period.collected),
      amount(period.remitted),
      amount(period.closing),
      String(period.postings),
      amount(period.stripeBooked),
      amount(period.stripeReported),
      amount(period.stripeDifference),
    ]);
  rows.push([
    text("Whole range"),
    text(summary.from),
    text(summary.to),
    amount(summary.opening),
    amount(summary.collected),
    amount(summary.remitted),
    amount(summary.closing),
    String(summary.periods.reduce((sum, period) => sum + period.postings, 0)),
    amount(summary.stripe.booked),
    amount(summary.stripe.reported),
    amount(formatMoney(parseMoney(summary.stripe.booked) - parseMoney(summary.stripe.reported))),
  ]);
  rows.push([]);
  for (const account of summary.accounts)
    rows.push([
      text("Account"),
      text(`${account.code} ${account.name}`),
      text("Balance at the end of the range"),
      amount(account.balance),
    ]);
  if (summary.accounts.length === 0)
    rows.push([
      text("Account"),
      text(
        "No liability account is tagged tax.sales, so nothing is summarised. Tag the account that holds sales tax collected in your chart of accounts.",
      ),
    ]);
  for (const warning of summary.warnings)
    rows.push([text("Warning"), text(warning.code), text(warning.message)]);
  for (const note of summary.notes) rows.push([text("Note"), text(note.key), text(note.text)]);
  return render([...headerRows(h), ...rows]);
}

/** Every posting on the account in the range with its journal, so any figure can be followed to the
 * entry it came from. */
export function salesPostingsCsv(h: TaxFileHeader, postings: readonly SalesPostingRow[]): string {
  const rows: string[][] = [
    [
      "Date",
      "Period",
      "Journal ID",
      "Posting ID",
      "Account",
      "Narration",
      "Where it came from",
      "Tax collected (credit)",
      "Tax paid or returned (debit)",
    ].map(text),
  ];
  for (const posting of postings)
    rows.push([
      text(posting.date),
      text(posting.period),
      text(posting.journalId),
      text(posting.postingId),
      text(`${posting.account.code} ${posting.account.name}`),
      text(posting.narration),
      text(ORIGIN_WORD[posting.origin]),
      amount(formatMoney(posting.collected)),
      amount(formatMoney(posting.paid)),
    ]);
  return render([...headerRows(h), ...rows]);
}

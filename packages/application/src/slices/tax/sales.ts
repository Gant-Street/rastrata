/** The operations behind the sales-tax summary: reading what the Inbox and the Stripe lane say about
 * Stripe's payouts (through their own operations, never their tables), building the request, and the
 * two files the year-end pack carries.
 *
 * Reads only: nothing here records or changes anything. Rastrata does not know sales tax rates or
 * filing dates and says so in the summary itself. */
import type { BookState } from "@rastrata/kernel";

import type { AccountTagMap } from "../../account-tags.ts";
import type { InboxPage, StripeStatus } from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { parseMoney } from "../../money.ts";
import { addDays } from "../../reports/dates.ts";
import type { TaxFileHeader } from "../../tax/csv.ts";
import { CSV_TYPE, type TaxFile } from "../../tax/files.ts";
import {
  hasSalesAccount,
  type SalesPeriodKind,
  type SalesTaxAnalysis,
  type SalesTaxRequest,
  type StripeFigures,
  type StripePayoutTax,
  SALES_TAX_ROLE_KEY,
} from "../../tax/sales.ts";
import { salesHeader, salesPostingsCsv, salesSummaryCsv } from "../../tax/sales-csv.ts";
import type { SliceContext } from "../types.ts";
import { booksStartOn, revisionOf, tagsOf, taxRange } from "./context.ts";
import { callOperation } from "./operations.ts";

export const salesPeriodKind = (value: unknown): SalesPeriodKind =>
  value === "quarter" || value === "year" ? value : "month";

/** What the Inbox says about the Stripe payouts booked around a range: for each, the tax leg of the
 * event, which is the tax Stripe itself reported on the payout's transactions. The window is a little
 * wider than the range because an entry's date can differ from the date of the payout it books.
 * Null when the Inbox could not be read. */
export async function stripePayouts(
  context: SliceContext,
  from: string,
  to: string,
): Promise<StripePayoutTax[] | null> {
  const payouts: StripePayoutTax[] = [];
  try {
    for (let page = 1; ; page++) {
      const result = await callOperation<InboxPage>(context, "inbox.list", {
        filter: {
          provider: "stripe",
          status: ["posted"],
          covered: false,
          from: addDays(from, -31),
          to: addDays(to, 31),
        },
        sort: "date_asc",
        page,
        pageSize: 200,
      });
      for (const item of result.items) {
        if (!item.journalId || item.line.kind !== "event") continue;
        let cents = 0n;
        for (const leg of item.line.legs ?? [])
          if (leg.role === SALES_TAX_ROLE_KEY) cents += parseMoney(leg.amount);
        payouts.push({
          journalId: item.journalId,
          providerId: item.line.providerId ?? "",
          cents,
        });
      }
      if (result.items.length === 0 || page * result.pageSize >= result.count) break;
    }
    return payouts;
  } catch (error) {
    if (error instanceof ApplicationError) return null;
    throw error;
  }
}

/** The Stripe lane's own account of its settings and the charges it could not split. Null when Stripe
 * could not be read. */
export async function stripeFigures(context: SliceContext): Promise<StripeFigures | null> {
  try {
    const status = await callOperation<StripeStatus>(context, "stripe.status", {});
    return {
      configured: status.configured,
      salesTax: status.settings?.salesTax ?? null,
      taxNotReported: status.held.taxNotReported,
      refundsWithoutTaxSplit: status.held.refundsWithoutTaxSplit,
    };
  } catch (error) {
    if (error instanceof ApplicationError) return null;
    throw error;
  }
}

/** The request an operation's input describes, read from the book as it stands (or at a pinned
 * revision). A caller that has already read the book (the year-end pack) passes it, so every file of
 * one pack is from one revision. */
export async function salesRequest(
  input: Record<string, unknown>,
  context: SliceContext,
  base?: { readonly state: BookState; readonly tags: AccountTagMap },
): Promise<{ readonly state: BookState; readonly request: SalesTaxRequest }> {
  const { service } = context;
  const { taxYear, from, to } = taxRange(input);
  const state = base?.state ?? (await service.readAggregate(revisionOf(input))).aggregate.state;
  const tags = base?.tags ?? tagsOf(service, input);
  // With no account tagged there is nothing to compare with Stripe, so neither the Inbox nor Stripe
  // is read: a book that collects no sales tax pays nothing for the summary.
  const compare = hasSalesAccount(state, tags, from, to);
  return {
    state,
    request: {
      taxYear,
      from,
      to,
      period: salesPeriodKind(input.period),
      tags,
      today: service.today(),
      booksStartOn: booksStartOn(service),
      stripePayouts: compare ? await stripePayouts(context, from, to) : [],
      stripe: compare ? await stripeFigures(context) : null,
    },
  };
}

const SUMMARY_PATH = "tax/sales-tax.csv";
const POSTINGS_PATH = "tax/sales-tax-postings.csv";

/** The summary and the postings as pack files: the whole range cut by month, so a filer of any
 * frequency can add months up. */
export function salesPackFiles(
  analysis: SalesTaxAnalysis,
  book: string,
): readonly [TaxFile, TaxFile] {
  const { summary } = analysis;
  const header: TaxFileHeader = salesHeader(summary, book);
  return [
    {
      path: SUMMARY_PATH,
      mediaType: CSV_TYPE,
      description:
        "Sales tax by month from the account tagged tax.sales: balance at the start, tax collected (credits), tax paid or returned (debits) and balance at the end, beside what Stripe reported on its payouts. Rastrata does not know your rates, which sales are taxable or when a return is due.",
      content: salesSummaryCsv(header, summary),
      population: summary.populationHash,
    },
    {
      path: POSTINGS_PATH,
      mediaType: CSV_TYPE,
      description:
        "Every posting on the sales tax account in the range with its journal and where it came from, so any figure can be followed to the entry behind it.",
      content: salesPostingsCsv(header, analysis.postings),
      population: summary.populationHash,
    },
  ];
}

export function salesExportFile(analysis: SalesTaxAnalysis, book: string, which: unknown): TaxFile {
  const [summary, postings] = salesPackFiles(analysis, book);
  return which === "postings" ? postings : summary;
}

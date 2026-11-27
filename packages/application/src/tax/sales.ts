/** The sales-tax summary: what the books recorded in the liability account tagged `tax.sales`, period by
 * period, beside the tax Stripe itself reported on the payouts booked in the same period.
 *
 * What it is and is not. It reports what is in the books. It does not know the rates, which sales are
 * taxable, which states or cities a business must collect in or file with, or when a return is due,
 * and it never says what is owed to anyone. The balance is what the account holds, nothing more: a
 * credit to the account is tax collected, a debit is tax paid or returned, and the books cannot tell a
 * payment to a state from a refund of tax to a customer or a correction, so every debit is listed with
 * its journal.
 *
 * Exactness. Everything is integer cents in a bigint. The summary is built from the account's
 * postings and checked against the same ledger the statements read: the closing balance has to equal
 * the account's balance as the balance sheet shows it on the last day, or the summary is refused and
 * never shown.
 *
 * Pure and portable: a function of a book state, a tag map, a request and what the Inbox said about
 * Stripe's payouts. It reads no clock; today is passed in. */
import { hashCanonical, type BookState } from "@rastrata/kernel";

import type { AccountTagMap } from "../account-tags.ts";
import type {
  TaxNote,
  TaxSalesAccount,
  TaxSalesCandidate,
  TaxSalesPeriod,
  TaxSalesSummary,
} from "../client-contracts.gen.ts";
import { ApplicationError } from "../errors.ts";
import { formatMoney } from "../money.ts";
import {
  chartAccounts,
  compareCodes,
  configurationAt,
  type ChartAccount,
} from "../reports/chart.ts";
import { compileColumn, reportContext, resolveRange } from "../reports/columns.ts";
import { addDays, daysInMonth, endOfMonth, formatDate, parseDate } from "../reports/dates.ts";
import { postingCents } from "../reports/ledger.ts";
import { TAX_DISCLAIMER_LONG } from "./sources.ts";

export const SALES_TAX_VERSION = "rastrata-sales-tax-v1";

/** The role key the chart lane gives the liability account that holds sales tax collected. */
export const SALES_TAX_ROLE_KEY = "tax.sales";

/** Months in the longest range a summary is made for (five years). A longer range is a mistake. */
export const MAX_SALES_PERIODS = 60;

export type SalesPeriodKind = "month" | "quarter" | "year";

/** Where a journal on the account came from, as far as the Inbox says: a Stripe payout booked as one
 * entry, or anything else (a bank line, or an entry typed in). */
export type SalesOrigin = "stripe" | "other";

/** What Stripe reported on one payout the Inbox booked: the tax leg of its event. */
export interface StripePayoutTax {
  readonly journalId: string;
  /** The payout's id at Stripe. Text from outside: shown as data, never as an instruction. */
  readonly providerId: string;
  /** Ledger-signed: the tax collected on the payout (a credit to the account) is negative. */
  readonly cents: bigint;
}

/** What the Stripe lane says about its own settings and the charges it could not split. These are
 * read as they stand on the day of the request, not as they stood at a pinned book revision, so they
 * are context beside the figures and are not part of the population hash. */
export interface StripeFigures {
  readonly configured: boolean;
  readonly salesTax: "stripe" | "none" | null;
  readonly taxNotReported: number | null;
  readonly refundsWithoutTaxSplit: number | null;
}

export interface SalesTaxRequest {
  readonly taxYear: number;
  readonly from: string;
  readonly to: string;
  readonly period: SalesPeriodKind;
  readonly tags: AccountTagMap;
  /** Today's date, so a range that has not ended says it is the figures so far. */
  readonly today: string;
  /** The first day the books hold, when a cutover date is recorded. */
  readonly booksStartOn: string | null;
  /** The tax leg of each Stripe payout the Inbox booked; null when the Inbox could not be read. */
  readonly stripePayouts: readonly StripePayoutTax[] | null;
  /** From the Stripe lane's status; null when it could not be read. */
  readonly stripe: StripeFigures | null;
}

/** One posting on the account in the range. The amounts are not signed: a credit is tax collected, a
 * debit is tax paid or returned. */
export interface SalesPostingRow {
  readonly period: string;
  readonly date: string;
  readonly journalId: string;
  readonly postingId: string;
  readonly narration: string;
  readonly account: ChartAccount;
  readonly origin: SalesOrigin;
  readonly collected: bigint;
  readonly paid: bigint;
}

export interface SalesTaxAnalysis {
  readonly summary: TaxSalesSummary;
  readonly postings: readonly SalesPostingRow[];
}

const doesNotTie = (message: string) => new ApplicationError("report_does_not_tie", message, 500);

/** The plain statement every sales-tax output carries. */
export const SALES_TAX_STATEMENT =
  "Rastrata does not know your sales tax rates, which of your sales are taxable, which states or cities you must collect in or file with, or when a return is due. These figures are only what your books recorded in the liability account tagged tax.sales: a credit is tax collected, a debit is tax paid or returned. You or your accountant decide what is owed and file the return.";

export interface SalesPeriodSpec {
  /** "2026-03", "2026-Q1" or "2026": fixed words and digits, never text from the book. */
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The calendar months, quarters or the one span that cover a range, each cut at the range's ends. */
export function salesPeriods(
  from: string,
  to: string,
  kind: SalesPeriodKind,
): readonly SalesPeriodSpec[] {
  const first = parseDate(from);
  const last = parseDate(to);
  if (!first || !last || from > to) throw new TypeError("Invalid range");
  if (kind === "year") {
    const key = first.year === last.year ? String(first.year) : `${from} to ${to}`;
    return [{ key, from, to }];
  }
  const periods: SalesPeriodSpec[] = [];
  let cursor = from;
  while (cursor <= to) {
    const parts = parseDate(cursor);
    if (!parts) throw new TypeError("Invalid date");
    let end: string;
    let key: string;
    if (kind === "month") {
      end = endOfMonth(cursor);
      key = `${parts.year}-${pad(parts.month)}`;
    } else {
      const quarter = Math.floor((parts.month - 1) / 3);
      const lastMonth = quarter * 3 + 3;
      end = formatDate(parts.year, lastMonth, daysInMonth(parts.year, lastMonth));
      key = `${parts.year}-Q${quarter + 1}`;
    }
    const cut = end < to ? end : to;
    periods.push({ key, from: cursor, to: cut });
    if (periods.length > MAX_SALES_PERIODS)
      throw new ApplicationError(
        "invalid_input",
        `A sales-tax summary covers at most ${MAX_SALES_PERIODS} periods. Choose a shorter range or longer periods.`,
        400,
      );
    cursor = addDays(cut, 1);
  }
  return periods;
}

/** Liability accounts a person may tag, for the screen that explains what to do when none is tagged.
 * A name that says "sales tax" is a hint and never a decision. */
const SALES_TAX_NAME = /sales\s*tax/i;

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

const NOTES: readonly TaxNote[] = [
  {
    key: "account",
    text: "The summary reads the liability account tagged tax.sales (as the tags stand on the first and last day of the range). A credit to it is tax collected and a debit is tax paid or returned. The books cannot tell a payment to a state from a refund of tax to a customer or a correction, so every debit is listed with its journal.",
    sources: [],
  },
  {
    key: "stripe",
    text: "Where Stripe reports the tax on a payment (on the Checkout Session or the invoice that collected it), Rastrata books that figure to the account. Where Stripe reports none, the whole amount is booked as sales and the charge is counted as tax not reported. The Stripe columns compare what the account took from the payouts booked in the period with what Stripe reported on the same payouts.",
    sources: [],
  },
  {
    key: "periods",
    text: "Periods are calendar months, quarters or the whole range, cut by the date of each journal. Rastrata does not know whether you file monthly, quarterly or yearly, or the dates a return is due.",
    sources: [],
  },
];

/** Whether any liability account carries the tax.sales tag on the first or last day of the range. A caller
 * that would read other lanes (the Inbox, Stripe) to compare with the account asks this first, so a
 * book that collects no sales tax costs nothing. */
export function hasSalesAccount(
  state: BookState,
  tags: AccountTagMap,
  from: string,
  to: string,
): boolean {
  return chartAccounts(configurationAt(state, to)).some(
    (account) =>
      account.role === "liability" &&
      (tags.tagsFor(account.id, from).roleKey === SALES_TAX_ROLE_KEY ||
        tags.tagsFor(account.id, to).roleKey === SALES_TAX_ROLE_KEY),
  );
}

/** The sales-tax summary and the postings behind it, from one pass over the book. */
export function analyzeSalesTax(state: BookState, request: SalesTaxRequest): SalesTaxAnalysis {
  const context = reportContext(state, request.to);
  const range = resolveRange(context, request.to, request.from);
  const specs = salesPeriods(range.from, request.to, request.period);
  const column = compileColumn(context, range.from, request.to);

  const roleKeyOn = (account: ChartAccount, date: string) =>
    request.tags.tagsFor(account.id, date).roleKey;
  const holders = context.accounts
    .filter(
      (account) =>
        roleKeyOn(account, range.from) === SALES_TAX_ROLE_KEY ||
        roleKeyOn(account, request.to) === SALES_TAX_ROLE_KEY,
    )
    .sort((left, right) => compareCodes(left.code, right.code));
  const accounts = holders.filter((account) => account.role === "liability");
  const warnings: { code: string; message: string }[] = [];
  for (const account of holders)
    if (account.role !== "liability")
      warnings.push({
        code: "account_not_liability",
        message: `Account ${account.code} is tagged tax.sales but is not a liability account, so it is left out. Sales tax collected for others is held in a liability account.`,
      });
  if (accounts.length > 1)
    warnings.push({
      code: "several_accounts",
      message: `${accounts.length} accounts carry the tax.sales tag on the first or last day of the range (${accounts
        .map((account) => account.code)
        .join(", ")}). Their postings are added together.`,
    });

  const candidates: TaxSalesCandidate[] =
    accounts.length > 0
      ? []
      : context.accounts
          .filter((account) => account.role === "liability")
          .sort((left, right) => compareCodes(left.code, right.code))
          .slice(0, 100)
          .map((account) => ({
            accountId: account.id,
            code: account.code,
            name: account.name,
            suggested: SALES_TAX_NAME.test(account.name),
          }));

  // Which period holds a date: the periods are consecutive and cover the range.
  const periodOf = (date: string): number => {
    for (let index = 0; index < specs.length; index++)
      if (date <= (specs[index] as SalesPeriodSpec).to) return index;
    return specs.length - 1;
  };

  const ids = new Set(accounts.map((account) => account.id));
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const included = context.view.included(request.to);
  const stripeByJournal = new Map<string, StripePayoutTax[]>();
  for (const payout of request.stripePayouts ?? []) {
    const list = stripeByJournal.get(payout.journalId) ?? [];
    list.push(payout);
    stripeByJournal.set(payout.journalId, list);
  }

  const rows: SalesPostingRow[] = [];
  const counted = specs.map(() => ({
    collected: 0n,
    paid: 0n,
    postings: 0,
    stripeBooked: 0n,
    stripeReported: 0n,
  }));
  const countedPayouts = new Map<string, StripePayoutTax>();
  for (const booked of included.journals) {
    const date = booked.journal.accountingDate as string;
    if (date < range.from) continue;
    const journalId = booked.journal.id as string;
    const payouts = stripeByJournal.get(journalId);
    const slot = counted[periodOf(date)] as (typeof counted)[number];
    if (payouts)
      for (const payout of payouts) {
        slot.stripeReported -= payout.cents;
        countedPayouts.set(`${payout.journalId}\u0000${payout.providerId}`, payout);
      }
    for (const posting of booked.journal.postings) {
      const accountId = posting.accountId as string;
      if (!ids.has(accountId)) continue;
      const cents = postingCents(posting);
      const collected = cents < 0n ? -cents : 0n;
      const paid = cents > 0n ? cents : 0n;
      slot.collected += collected;
      slot.paid += paid;
      slot.postings += 1;
      if (payouts) slot.stripeBooked += collected - paid;
      rows.push({
        period: (specs[periodOf(date)] as SalesPeriodSpec).key,
        date,
        journalId,
        postingId: posting.id as string,
        narration: booked.journal.narration,
        account: byId.get(accountId) as ChartAccount,
        origin: payouts ? "stripe" : "other",
        collected,
        paid,
      });
    }
  }

  // The ledger's own sums for the same accounts: the opening balance is everything before the range,
  // and the closing balance has to be the balance sheet's figure for the last day.
  let cumulative = 0n;
  let inRange = 0n;
  for (const id of ids) {
    cumulative += column.accumulated.cumulative.get(id) ?? 0n;
    inRange += column.accumulated.range.get(id) ?? 0n;
  }
  const opening = -(cumulative - inRange);
  let running = opening;
  let collectedTotal = 0n;
  let paidTotal = 0n;
  let stripeBookedTotal = 0n;
  let stripeReportedTotal = 0n;
  const periods: TaxSalesPeriod[] = specs.map((spec, index) => {
    const slot = counted[index] as (typeof counted)[number];
    const start = running;
    running = start + slot.collected - slot.paid;
    collectedTotal += slot.collected;
    paidTotal += slot.paid;
    stripeBookedTotal += slot.stripeBooked;
    stripeReportedTotal += slot.stripeReported;
    return {
      key: spec.key,
      from: spec.from,
      to: spec.to,
      opening: formatMoney(start),
      collected: formatMoney(slot.collected),
      remitted: formatMoney(slot.paid),
      closing: formatMoney(running),
      postings: slot.postings,
      stripeBooked: formatMoney(slot.stripeBooked),
      stripeReported: formatMoney(slot.stripeReported),
      stripeDifference: formatMoney(slot.stripeBooked - slot.stripeReported),
    };
  });
  const closing = running;
  if (closing !== -cumulative)
    throw doesNotTie("The sales-tax summary does not tie to the account's balance in the ledger");
  if (collectedTotal - paidTotal !== -inRange)
    throw doesNotTie("The sales-tax summary does not tie to the account's activity in the ledger");

  const stripeRead = request.stripePayouts !== null;
  const differing = periods.filter((period) => period.stripeDifference !== "0.00");
  if (stripeRead && differing.length > 0)
    warnings.push({
      code: "stripe_differs",
      message: `In ${differing
        .slice(0, 4)
        .map((period) => period.key)
        .join(
          ", ",
        )}${differing.length > 4 ? " and more" : ""} the account took a different amount from Stripe payouts than Stripe reported on them. A journal may have been changed or reversed after the payout was booked. Look at the postings.`,
    });
  if (!stripeRead)
    warnings.push({
      code: "stripe_not_read",
      message:
        "The Inbox could not be read, so what Stripe reported on payouts is not compared with the account.",
    });
  const negative = periods.filter((period) => period.closing.startsWith("-"));
  if (accounts.length > 0 && negative.length > 0)
    warnings.push({
      code: "negative_balance",
      message: `The account shows more tax paid or returned than collected at the end of ${negative
        .slice(0, 4)
        .map((period) => period.key)
        .join(
          ", ",
        )}${negative.length > 4 ? " and more" : ""}. That can be an overpayment, a payment recorded twice, or tax collected before the books start.`,
    });
  if (request.stripe?.taxNotReported)
    warnings.push({
      code: "stripe_tax_not_reported",
      message: `${request.stripe.taxNotReported} ${plural(request.stripe.taxNotReported, "Stripe charge has", "Stripe charges have")} no tax figure from Stripe and ${plural(request.stripe.taxNotReported, "is", "are")} flagged in the Inbox. Their whole amount is booked as sales, never guessed.`,
    });
  if (request.to > request.today)
    warnings.push({
      code: "year_not_ended",
      message: `This range ends on ${request.to}, after today (${request.today}), so these are the figures so far.`,
    });
  if (request.booksStartOn && request.booksStartOn > range.from)
    warnings.push({
      code: "books_start_late",
      message: `The books start on ${request.booksStartOn} (the cutover date). Activity from ${range.from} to the day before is not in Rastrata, so the opening balance may be missing tax collected earlier.`,
    });
  if (range.from !== `${request.taxYear}-01-01` || request.to !== `${request.taxYear}-12-31`)
    warnings.push({
      code: "range_not_calendar_year",
      message: `The range is ${range.from} to ${request.to}, not 1 January to 31 December ${request.taxYear}.`,
    });

  const evidence = {
    origins: [...new Set(rows.map((row) => `${row.journalId}:${row.origin}`))].sort(),
    payouts: [...countedPayouts.values()]
      .map((payout) => [payout.journalId, payout.providerId, payout.cents] as const)
      .sort((left, right) =>
        left.join() < right.join() ? -1 : left.join() > right.join() ? 1 : 0,
      ),
  };
  const populationHash = hashCanonical({
    type: "TaxSalesPopulation",
    compilerVersion: SALES_TAX_VERSION,
    ledgerPopulationHash: column.populationHash,
    tagMapHash: request.tags.hash,
    taxYear: BigInt(request.taxYear),
    from: range.from,
    to: request.to,
    period: request.period,
    accounts: accounts.map((account) => account.id),
    evidence,
  }).digest;

  const summary: TaxSalesSummary = {
    compilerVersion: SALES_TAX_VERSION,
    populationHash,
    ledgerPopulationHash: column.populationHash,
    tagMapHash: request.tags.hash,
    tagsRevision: String(request.tags.revision),
    bookRevision: state.bookRevision.toString(),
    currency: state.identity.functionalCommodityId,
    basis: context.basis,
    taxYear: request.taxYear,
    from: range.from,
    to: request.to,
    period: request.period,
    accounts: accounts.map(
      (account): TaxSalesAccount => ({
        accountId: account.id,
        code: account.code,
        name: account.name,
        balance: formatMoney(-(column.accumulated.cumulative.get(account.id) ?? 0n)),
      }),
    ),
    candidates,
    opening: formatMoney(opening),
    collected: formatMoney(collectedTotal),
    remitted: formatMoney(paidTotal),
    closing: formatMoney(closing),
    periods,
    stripe: {
      read: stripeRead,
      payouts: countedPayouts.size,
      booked: formatMoney(stripeBookedTotal),
      reported: formatMoney(stripeReportedTotal),
      salesTax: request.stripe?.salesTax ?? null,
      taxNotReported: request.stripe?.taxNotReported ?? null,
      refundsWithoutTaxSplit: request.stripe?.refundsWithoutTaxSplit ?? null,
    },
    statement: SALES_TAX_STATEMENT,
    notes: [...NOTES],
    warnings,
    disclaimer: TAX_DISCLAIMER_LONG,
  };
  return { summary, postings: rows };
}

import type { TaxFormId, TaxSalesPeriodKind } from "@rastrata/ui/tax/types";

/** What the Tax screen keeps in its address, and the small pure helpers around it: so a reload, a link and the
 * back button all land on the same year, tab and options. Nothing here reads a clock or the page. */

export const TAX_TABS = ["worksheet", "pack", "vendors", "sales", "accountant"] as const;
export type TaxTab = (typeof TAX_TABS)[number];

export const TAX_FORMS: readonly TaxFormId[] = ["scheduleC", "form1120S", "form1065"];
export const MEALS_CHOICES = [50, 80] as const;
export type MealsPercent = (typeof MEALS_CHOICES)[number];

export interface TaxScreenState {
  readonly tab: TaxTab;
  /** The tax year, or null to let the service choose the one to show. */
  readonly year: number | null;
  /** The form, or null to let the service choose from the book's tags. */
  readonly form: TaxFormId | null;
  readonly meals: MealsPercent;
  readonly period: TaxSalesPeriodKind;
}

export const defaultTaxState = (): TaxScreenState => ({
  tab: "worksheet",
  year: null,
  form: null,
  meals: 50,
  period: "month",
});

const isTab = (value: string | null): value is TaxTab =>
  value !== null && (TAX_TABS as readonly string[]).includes(value);
const isForm = (value: string | null): value is TaxFormId =>
  value !== null && (TAX_FORMS as readonly string[]).includes(value);
const isPeriod = (value: string | null): value is TaxSalesPeriodKind =>
  value === "month" || value === "quarter" || value === "year";

/** The state an address names. An address is data: anything that is not a known value is the default, never
 * an error and never reflected back as text. */
export function parseTaxState(search: string): TaxScreenState {
  const query = new URLSearchParams(search);
  const defaults = defaultTaxState();
  const tab = query.get("tab");
  const year = query.get("year");
  const form = query.get("form");
  const meals = query.get("meals");
  const period = query.get("period");
  return {
    tab: isTab(tab) ? tab : defaults.tab,
    year: year !== null && /^(19|20|21)[0-9]{2}$/.test(year) ? Number(year) : defaults.year,
    form: isForm(form) ? form : defaults.form,
    meals: meals === "80" ? 80 : defaults.meals,
    period: isPeriod(period) ? period : defaults.period,
  };
}

/** The query that names a state, leaving out what is the default so a plain address stays plain. */
export function serializeTaxState(state: TaxScreenState): string {
  const defaults = defaultTaxState();
  const query = new URLSearchParams();
  if (state.tab !== defaults.tab) query.set("tab", state.tab);
  if (state.year !== null) query.set("year", String(state.year));
  if (state.form !== null) query.set("form", state.form);
  if (state.meals !== defaults.meals) query.set("meals", String(state.meals));
  if (state.period !== defaults.period) query.set("period", state.period);
  return query.toString();
}

/** Where an account's activity for some dates is, in the population a tax figure was read from. The page this
 * leads to checks the population and says so if the book has moved since. */
export function activityHref(input: {
  accountId: string;
  /** The whole range the figure was read for, and the population of that range. */
  asOf: string;
  reportFrom: string;
  population: string;
  /** The dates of the postings to show. */
  from: string;
  to: string;
}): string {
  const query = new URLSearchParams({
    accountId: input.accountId,
    asOf: input.asOf,
    population: input.population,
    reportFrom: input.reportFrom,
    from: input.from,
    to: input.to,
  });
  return `/ledger?${query.toString()}`;
}

/** A file name for a download that cannot carry anything but plain characters, whatever the service said. */
export function safeDownloadName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return cleaned === "" ? "download" : cleaned.slice(0, 120);
}

/** The empty template an accountant fills in: the header row alone, so nothing can be imported from it by
 * mistake. It is the same text the accountant pack carries. */
export const ADJUSTMENTS_TEMPLATE = "Entry,Date,Narration,Account,Debit,Credit\r\n";

/** The most characters the service takes in one adjusting-entry file. A character is at least one byte, so a
 * file larger than this in bytes is refused before it is read. */
export const MAX_ADJUSTMENT_CHARACTERS = 2_000_000;
export const MAX_ADJUSTMENT_BYTES = 8_000_000;

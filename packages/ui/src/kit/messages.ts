import type { RangePresetId } from "./date-range";

/** The words the kit's components own. They are read through `useUi().messages.kit`, so an application can
 * reword or translate them through `UiProvider` like every other component's copy. Data (an account's
 * name, a hash, an amount) is never in this file. */
export const kitMessages = {
  details: {
    /** The visible label on a copy button. */
    copy: "Copy",
    copied: "Copied",
    /** The accessible name of a copy button, once the thing it copies has a name: "Copy fingerprint". */
    copyOf: (what: string) => `Copy ${what}`,
    copiedOf: (what: string) => `Copied ${what}`,
    /** Said, and shown, when the clipboard would not take it, so nobody believes it was copied. */
    copyFailed: "Could not copy. Select the text and copy it yourself.",
  },
  toast: {
    /** The name of the region that holds the notifications. */
    region: "Notifications",
    dismiss: "Dismiss",
  },
  dateRange: {
    label: "Date range",
    /** The periods, named as Xero and QuickBooks name them. */
    presets: {
      thisMonth: "This month",
      lastMonth: "Last month",
      thisQuarter: "This quarter",
      lastQuarter: "Last quarter",
      fiscalYearToDate: "This fiscal year to date",
      lastFiscalYear: "Last fiscal year",
      custom: "Custom",
      all: "All dates",
    } as Record<RangePresetId, string>,
    /** What a range with no dates covers, for the line under the field. */
    everyDate: "Every date",
    /** Said beside a period this book's calendar does not cover. */
    unavailable: "not in this book's calendar",
    from: "From",
    to: "To",
    loading: "Reading the book's calendar…",
    loadError: "The book's calendar could not be read.",
    noCalendar: "This book has no calendar yet.",
    incomplete: "Enter both dates, from and to.",
    order: "The start date is after the end date.",
    outside: (first: string, last: string) =>
      `Choose dates from ${first} to ${last}, the dates this book's fiscal calendar covers.`,
  },
  /** The button that opens a list's folded filters, and what it says while some are on. */
  filter: "Filter",
  filterOn: (label: string, count: number) => `${label}, ${count} on`,
  /** What a tone's marker says to a screen reader, before the row's own words. A calm marker is a fact
   * and says nothing. */
  tone: {
    calm: "",
    info: "Good to know",
    attention: "Needs attention",
    problem: "Problem",
  },
};

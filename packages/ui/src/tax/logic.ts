/** The small amount of logic the tax screens need that is not presentation: turning what a person typed
 * into what the service takes, and the checks that run before a request is sent. The service checks
 * everything again; these only spare a round trip and say what is wrong next to the field. Pure. */
import { formatFiguresInText, isDate } from "../format";
import type {
  TaxCheckStatus,
  TaxCheckView,
  TaxSalesPeriodView,
  TaxVendorFormErrors,
  TaxVendorFormValues,
  TaxVendorView,
} from "./types";
import { words } from "./words";

// ---- The checks, by what they ask of the person -------------------------------------------------

/** What a check asks of the person.
 *
 * - `attention` (orange): acting would change the figures on the page. Transactions still waiting for
 *   review are not in the figures; an account with no tax line is not on any line. Orange is rationed
 *   to this, so a book that is simply new, or a year that is simply not over, shows none.
 * - `calm` (grey): good practice a person can ignore: the months are closed, the accounts are
 *   reconciled, the 1099 vendors are decided. Doing it protects the books and changes no figure.
 * - `note` (plain text): a fact about the figures that nobody can act on: the form is an early
 *   release, the year is not over, the books start part-way through it. */
export type TaxCheckSeverity = "attention" | "calm" | "note";

/** The facts about the figures. They are the same on any day and any book that has them, so they are
 * notes whatever the service's status says. */
const NOTES: ReadonlySet<string> = new Set(["draft", "books_start", "year_not_ended"]);

/** The checks whose being undone changes a figure: orange when the service says they need a look. A
 * check that could not be made is never orange: it says what is not known and offers a way to find out. */
const CHANGES_FIGURES: ReadonlySet<string> = new Set(["inbox", "unmapped", "sales"]);

/** Which of the three kinds a check is. A check this screen has not heard of keeps what the service said:
 * orange when it needs a look, grey otherwise, so a new check is never silently hidden. */
export function severityOf(check: Pick<TaxCheckView, "key" | "status">): TaxCheckSeverity {
  if (NOTES.has(check.key)) return "note";
  if (check.status !== "attention") return "calm";
  if (CHANGES_FIGURES.has(check.key)) return "attention";
  // Good practice: closing the months, reconciling, the 1099 list. A check this screen does not know is
  // the service's word.
  return KNOWN_GOOD_PRACTICE.has(check.key) ? "calm" : "attention";
}
const KNOWN_GOOD_PRACTICE: ReadonlySet<string> = new Set(["periods", "reconcile", "vendors"]);

/** One check as the screen shows it: the words, the kind and what its link names. */
export interface TaxCheckItem {
  readonly key: string;
  readonly status: TaxCheckStatus;
  readonly severity: TaxCheckSeverity;
  readonly title: string;
  readonly detail: string;
  /** Where it is fixed, as a path. Never set for a check that passed. */
  readonly href?: string | undefined;
  /** What the link fixes: "Review 4 transactions", "Close the books". Set with `href`. */
  readonly fix?: string | undefined;
}

/** What a link names, from the check, its state and what it counted. */
function fixLabel(check: TaxCheckView): string {
  switch (check.key) {
    case "periods":
      return words.fixClose;
    case "inbox":
      return words.fixReview(check.count);
    case "reconcile":
      return words.fixReconcile(check.count);
    case "unmapped":
      return words.fixTaxLines(check.count);
    case "vendors":
      return check.status === "unknown" ? words.fixMarkVendorAccounts : words.fixVendors;
    case "sales":
      return check.status === "unknown" ? words.fixTagSalesTax : words.fixSalesTax;
    default:
      return words.fixOther(check.title);
  }
}

/** What the check about the transactions waiting for review says, in the app's own words: the service
 * writes "lines" and "the Inbox", which are its words, and the app calls them transactions and For
 * review. The other checks are said as the service said them. */
function inboxDetail(check: TaxCheckView, year: number): string | undefined {
  if (check.status === "unknown") return words.inboxUnknown(year);
  if (check.status === "ok") return words.inboxClear(year);
  return check.count === undefined ? undefined : words.inboxWaiting(check.count, year);
}

/** The sentence the service ends the sales tax check with, for a file or an agent to carry. A screen says
 * the finding and stops. */
const NOT_KNOWN = /\s*Rastrata does not know your rates or filing dates\.$/;

/** Describe one check for the screen: its kind, its title and sentence in the app's words, and a link
 * that names what it fixes. A check that passed has no link. */
export function describeCheck(check: TaxCheckView, year: number): TaxCheckItem {
  const detail =
    (check.key === "inbox" ? inboxDetail(check, year) : undefined) ??
    formatFiguresInText(check.detail.replace(NOT_KNOWN, ""));
  return {
    key: check.key,
    status: check.status,
    severity: severityOf(check),
    title: words.checkTitles[check.key] ?? check.title,
    detail,
    ...(check.href !== undefined && check.status !== "ok"
      ? { href: check.href, fix: fixLabel(check) }
      : {}),
  };
}

/** The checks sorted into what they ask: what to act on, the facts about the figures, and the good
 * practice with how much of it is done. A good-practice check that is not done comes before one that is,
 * so the open disclosure reads as a list of what is left. */
export function groupChecks(
  checks: readonly TaxCheckView[],
  year: number,
): {
  readonly attention: readonly TaxCheckItem[];
  readonly notes: readonly TaxCheckItem[];
  readonly calm: readonly TaxCheckItem[];
  readonly done: number;
} {
  const items = checks.map((check) => describeCheck(check, year));
  const calm = items
    .filter((item) => item.severity === "calm")
    .sort((left, right) => Number(left.status === "ok") - Number(right.status === "ok"));
  return {
    attention: items.filter((item) => item.severity === "attention"),
    notes: items.filter((item) => item.severity === "note"),
    calm,
    done: calm.filter((item) => item.status === "ok").length,
  };
}

/** How many checks are orange: the number a screen may say "need a look" about. */
export const attentionCount = (checks: readonly TaxCheckView[]): number =>
  checks.filter((check) => severityOf(check) === "attention").length;

// ---- The vendor form ----------------------------------------------------------------------------

/** The shortest and longest a payee text can be. */
export const PAYEE_MIN = 3;
export const PAYEE_MAX = 120;
export const VENDOR_NOTES_MAX = 500;

/** Payee texts as typed: one per line, or separated by semicolons. Blank pieces are dropped and the same
 * text typed twice (in any case) is kept once. */
export function parsePayees(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const piece of text.split(/[\n;]/)) {
    const value = piece.trim();
    const key = value.toLowerCase();
    if (value === "" || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export const emptyVendorValues = (payee = ""): TaxVendorFormValues => ({
  name: payee ? payee.slice(0, 120) : "",
  payees: payee,
  reporting: "undecided",
  reason: "",
  w9: "not_requested",
  w9On: "",
  classification: "",
  paidBy: "unknown",
  notes: "",
  legalName: "",
  email: "",
  tinStatus: "not_collected",
  addressLine1: "",
  addressLine2: "",
  addressCity: "",
  addressState: "",
  addressPostalCode: "",
});

export const vendorValues = (vendor: TaxVendorView): TaxVendorFormValues => ({
  name: vendor.name,
  payees: vendor.payeeKeys.join("\n"),
  reporting: vendor.reporting,
  reason: vendor.reason ?? "",
  w9: vendor.w9,
  w9On: vendor.w9On ?? "",
  classification: vendor.classification ?? "",
  paidBy: vendor.paidBy,
  notes: vendor.notes,
  legalName: vendor.legalName ?? "",
  email: vendor.email ?? "",
  tinStatus: vendor.tinStatus ?? "not_collected",
  addressLine1: vendor.address?.line1 ?? "",
  addressLine2: vendor.address?.line2 ?? "",
  addressCity: vendor.address?.city ?? "",
  addressState: vendor.address?.state ?? "",
  addressPostalCode: vendor.address?.postalCode ?? "",
});

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/** What is wrong with a vendor form, field by field. An empty object means it can be sent. */
export function vendorErrors(values: TaxVendorFormValues): TaxVendorFormErrors {
  const errors: { -readonly [K in keyof TaxVendorFormErrors]: TaxVendorFormErrors[K] } = {};
  if (values.name.trim() === "") errors.name = words.formNameRequired;
  if (parsePayees(values.payees).some((text) => text.length < PAYEE_MIN || text.length > PAYEE_MAX))
    errors.payees = words.formPayeeShort;
  if (values.reporting === "no" && values.reason === "") errors.reason = words.formReasonRequired;
  if (values.w9On.trim() !== "" && !isDate(values.w9On.trim())) errors.w9On = words.formW9OnBad;
  const email = (values.email ?? "").trim();
  if (email !== "" && !EMAIL_SHAPE.test(email)) errors.email = words.formEmailBad;
  return errors;
}

export const hasVendorErrors = (errors: TaxVendorFormErrors): boolean =>
  Object.values(errors).some((message) => message !== undefined);

/** The fields of `taxVendors.save` for a form. A field that can be cleared is null when empty. The reason
 * only goes with "does not need a 1099". Optional filing details are included when populated or when
 * clearing a value already recorded on `existing`. */
export function vendorFields(values: TaxVendorFormValues, existing?: TaxVendorView | null) {
  const legalName = (values.legalName ?? "").trim();
  const email = (values.email ?? "").trim();
  const tinStatus = values.tinStatus ?? "not_collected";
  const line1 = (values.addressLine1 ?? "").trim();
  const line2 = (values.addressLine2 ?? "").trim();
  const city = (values.addressCity ?? "").trim();
  const state = (values.addressState ?? "").trim().toUpperCase();
  const postalCode = (values.addressPostalCode ?? "").trim();
  const hasAddress = Boolean(line1 || line2 || city || state || postalCode);
  const address = hasAddress
    ? {
        ...(line1 ? { line1 } : {}),
        ...(line2 ? { line2 } : {}),
        ...(city ? { city } : {}),
        ...(state ? { state } : {}),
        ...(postalCode ? { postalCode } : {}),
      }
    : null;
  return {
    name: values.name.trim(),
    payeeKeys: parsePayees(values.payees),
    reporting: values.reporting,
    reason: values.reporting === "no" && values.reason !== "" ? values.reason : null,
    w9: values.w9,
    w9On: values.w9On.trim() === "" ? null : values.w9On.trim(),
    classification: values.classification === "" ? null : values.classification,
    paidBy: values.paidBy,
    notes: values.notes.trim(),
    ...(legalName !== "" || existing?.legalName ? { legalName: legalName || null } : {}),
    ...(email !== "" || existing?.email ? { email: email || null } : {}),
    ...(tinStatus !== "not_collected" ||
    (existing?.tinStatus !== undefined && existing.tinStatus !== "not_collected")
      ? { tinStatus }
      : {}),
    ...(hasAddress || existing?.address ? { address } : {}),
  } as const;
}

/** A sales-tax period as a person reads it: a month by name, a quarter as "2026 Q1", the whole range
 * as its dates. */
export function salesPeriodLabel(
  period: Pick<TaxSalesPeriodView, "key" | "from" | "to">,
  formatMonth: (date: string) => string,
  formatDate: (date: string) => string,
): string {
  if (/^\d{4}-\d{2}$/.test(period.key)) return formatMonth(period.from);
  if (/^\d{4}-Q[1-4]$/.test(period.key)) return period.key.replace("-", " ");
  return `${formatDate(period.from)} to ${formatDate(period.to)}`;
}

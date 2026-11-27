/** The thresholds above which a business must file Form 1099-NEC or Form 1099-MISC for a payee, and
 * the rules about which payments are not reported on those forms.
 *
 * Read from IRS.gov on 2026-10-04 (docs/reference/program/tax.md has the full record):
 *
 * - "Am I required to file a Form 1099 or other information return?" says: "For payments made before
 *   2026, the reporting threshold is $600. For payments made in 2026, the reporting threshold is $2,000.
 *   For payments made after 2026, see Pub. 1099 for the inflation-adjusted reporting threshold."
 * - Instructions for Forms 1099-MISC and 1099-NEC (12/2026): "For tax years beginning after 2025, the
 *   minimum threshold amount ... increased to $2,000 and may be adjusted for inflation beginning in
 *   calendar year 2027." File Form 1099-NEC for each person to whom you have paid at least $2,000 for
 *   services (including attorneys' fees); Form 1099-MISC at least $2,000 in rents, prizes and awards,
 *   other income, medical and health care payments and others, at least $10 in royalties and at least
 *   $600 in gross proceeds paid to an attorney; and either form for any payee from whom federal income
 *   tax was withheld, whatever the amount.
 * - Instructions for Forms 1099-MISC and 1099-NEC (Rev. April 2025), for tax year 2025: "$600".
 *
 * Only the tax years Rastrata has verified are here. A later year's threshold is adjusted for
 * inflation and is not in any publication that has been read, so it is refused rather than guessed.
 *
 * Rastrata books and reports. It files no forms and gives no tax advice. Pure and portable. */
import { SOURCES, type TaxRuleSource } from "./sources.ts";

export interface ReportingThreshold {
  readonly taxYear: number;
  /** The payment threshold for a payee in the year, in cents. */
  readonly cents: bigint;
  readonly sources: readonly TaxRuleSource[];
  /** What the IRS says of the year, in plain words. */
  readonly note: string;
}

const THRESHOLDS: readonly ReportingThreshold[] = [
  {
    taxYear: 2025,
    cents: 60_000n,
    sources: [SOURCES.amIRequired, SOURCES.instructions1099Apr2025],
    note: "For payments made before 2026 the IRS threshold is $600.",
  },
  {
    taxYear: 2026,
    cents: 200_000n,
    sources: [SOURCES.amIRequired, SOURCES.instructions1099Dec2026, SOURCES.pub1099],
    note: "For payments made in 2026 the IRS threshold is $2,000. From 2027 it may be adjusted for inflation.",
  },
];

export const THRESHOLD_YEARS: readonly number[] = THRESHOLDS.map((item) => item.taxYear);

export function reportingThreshold(taxYear: number): ReportingThreshold | undefined {
  return THRESHOLDS.find((item) => item.taxYear === taxYear);
}

/** Exceptions to the general threshold that the instructions state, so a person is not told a single
 * number is the whole rule. */
export const THRESHOLD_EXCEPTIONS =
  "Some payments have their own thresholds: royalties $10, and gross proceeds paid to an attorney $600 (Form 1099-MISC). A payee from whom you withheld federal income tax under the backup withholding rules is reported whatever the amount.";

export const CARD_AND_NETWORK_RULE =
  "Payments made with a credit card or payment card, and certain other payments including third-party network transactions, are reported by the payment settlement entity on Form 1099-K. They are not reported by you on Form 1099-NEC or Form 1099-MISC.";

export const NOT_REPORTED_RULE =
  "Some payments do not need a Form 1099-NEC or 1099-MISC even above the threshold: generally payments to a corporation, including an LLC taxed as a C or S corporation (but legal services, and medical or health care payments, to a corporation are reportable); payments for merchandise, telegrams, telephone, freight, storage and similar items; wages to employees (Form W-2); payments to a tax-exempt organization, the United States, a state or a foreign government; and personal payments, which are not reportable at all.";

export const W9_RULE =
  "Form W-9 is how a requester asks a payee for their taxpayer identification number and certifications. If a payee does not give a correct TIN, backup withholding at a flat 24% may apply to reportable payments. Rastrata records only whether a W-9 is on file and when. It never stores a TIN: keep the form itself somewhere safe.";

export const NOT_FILING_RULE =
  "Rastrata files nothing and fills in no form. This is a list for you or your accountant.";

export const W9_SOURCES: readonly TaxRuleSource[] = [
  SOURCES.w9Requester,
  SOURCES.backupWithholding,
  SOURCES.formW9,
];

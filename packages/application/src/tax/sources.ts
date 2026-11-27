/** Where the tax rules in this lane come from, and when they were read.
 *
 * Tax content is high stakes, so every rule the tax lane states is traced to an IRS publication that
 * was fetched and read, on the day recorded here, and is written down in
 * docs/reference/program/tax.md with the tax year it belongs to. A rule that could not be verified is
 * not stated as a rule: it is marked in the doc and left out of the product's copy. The lines of the
 * forms themselves are the chart lane's catalog (chart/tax-lines.ts, read 2026-10-03); this file
 * holds what the tax lane added.
 *
 * Rastrata books and reports. It does not give tax advice, file anything or predict a liability.
 * Pure and portable: data only. */

/** The day the sources below were read on IRS.gov. */
export const TAX_RULES_READ_ON = "2026-10-04";

export interface TaxRuleSource {
  readonly title: string;
  readonly url: string;
  readonly readOn: string;
}

const read = (title: string, url: string): TaxRuleSource => ({
  title,
  url,
  readOn: TAX_RULES_READ_ON,
});

export const SOURCES = {
  scheduleCInstructions: read(
    "Instructions for Schedule C (Form 1040) (2025)",
    "https://www.irs.gov/instructions/i1040sc",
  ),
  pub463: read(
    "Publication 463 (2025), Travel, Gift, and Car Expenses",
    "https://www.irs.gov/publications/p463",
  ),
  form1120SInstructions: read(
    "Instructions for Form 1120-S (2025)",
    "https://www.irs.gov/instructions/i1120s",
  ),
  form1065Instructions: read(
    "Instructions for Form 1065 (2025)",
    "https://www.irs.gov/instructions/i1065",
  ),
  instructions1099Dec2026: read(
    "Instructions for Forms 1099-MISC and 1099-NEC (12/2026)",
    "https://www.irs.gov/instructions/i1099mec",
  ),
  instructions1099Apr2025: read(
    "Instructions for Forms 1099-MISC and 1099-NEC (Rev. April 2025)",
    "https://www.irs.gov/pub/irs-prior/i1099mec--2025.pdf",
  ),
  amIRequired: read(
    "Am I required to file a Form 1099 or other information return?",
    "https://www.irs.gov/businesses/small-businesses-self-employed/am-i-required-to-file-a-form-1099-or-other-information-return",
  ),
  pub1099: read(
    "Publication 1099 (2026), General Instructions for Certain Information Returns",
    "https://www.irs.gov/publications/p1099",
  ),
  w9Requester: read(
    "Instructions for the Requester of Form W-9 (03/2024)",
    "https://www.irs.gov/instructions/iw9",
  ),
  formW9: read("Form W-9 (Rev. March 2024)", "https://www.irs.gov/pub/irs-pdf/fw9.pdf"),
  backupWithholding: read(
    "Topic no. 307, Backup withholding",
    "https://www.irs.gov/taxtopics/tc307",
  ),
  instructions1099K: read(
    "Instructions for Form 1099-K (12/2026)",
    "https://www.irs.gov/instructions/i1099k",
  ),
} as const;

export const TAX_DISCLAIMER_LONG =
  "Rastrata books and reports. It does not give tax advice, choose a tax line for you, file anything or predict what you owe. Verify every figure against the current IRS form and instructions, or with whoever prepares your return.";

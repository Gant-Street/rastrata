/** The notes that matter on a tax worksheet: what a figure is, what it is not, and the IRS
 * instruction each rule comes from. Every rule here was read from the IRS publication named in its
 * source on the day recorded there (docs/reference/program/tax.md has the tax year of each).
 *
 * Plain and specific. A note says what the instructions say and what Rastrata does about it; it
 * never tells a person what to do about their own return. Pure and portable. */
import type { TaxNote } from "../client-contracts.gen.ts";
import { SOURCES, TAX_RULES_READ_ON } from "./sources.ts";
import type { WorksheetFormId } from "./forms.ts";

type Cited = { readonly title: string; readonly url: string; readonly readOn: string };
const note = (key: string, text: string, ...sources: readonly Cited[]): TaxNote => ({
  key,
  text,
  ...(sources.length > 0 ? { sources } : {}),
});

const SCOPE =
  "What this is: your books totalled by the tax line each account is tagged with. It does not decide what is deductible, work out any tax or fill in a return. Lines that depend on facts the books do not hold, such as car and truck expenses, depreciation and the home office, are only as complete as the entries behind them.";

const DRAFT_SOURCES: Readonly<Record<WorksheetFormId, { title: string; url: string }>> = {
  scheduleC: {
    title: "Schedule C (Form 1040) 2026, IRS draft",
    url: "https://www.irs.gov/pub/irs-dft/f1040sc--dft.pdf",
  },
  form1120S: {
    title: "Form 1120-S 2026, IRS draft",
    url: "https://www.irs.gov/pub/irs-dft/f1120s--dft.pdf",
  },
  form1065: {
    title: "Form 1065 2026, IRS draft",
    url: "https://www.irs.gov/pub/irs-dft/f1065--dft.pdf",
  },
};

const draftNote = (formId: WorksheetFormId, name: string): TaxNote =>
  note(
    "draft",
    `The 2026 ${name} is an IRS early-release draft marked "DRAFT - DO NOT FILE". The IRS says there are never changes between the last posted draft and the final form unless legislation intervenes, but a draft is still a draft: confirm the line numbers against the final form.${
      formId === "scheduleC"
        ? " Interest has three lines on the draft: 16a mortgage, 16b vehicle loan and 16c other."
        : ""
    }`,
    { ...DRAFT_SOURCES[formId], readOn: TAX_RULES_READ_ON },
  );

export interface NoteContext {
  readonly form: WorksheetFormId;
  readonly taxYear: number;
  readonly basis: string;
  readonly mealsPercent: number;
  readonly formName: string;
  readonly draft: boolean;
}

export function worksheetNotes(context: NoteContext): TaxNote[] {
  const { form, mealsPercent, basis } = context;
  const notes: TaxNote[] = [note("scope", SCOPE)];
  if (form === "scheduleC") {
    notes.push(
      note(
        "meals",
        `Business meals (line 24b). The books record the full cost of each meal. The IRS instructions for line 24b say your deductible meals are a percentage of the actual cost and that in most cases the percentage is 50%; it is 80% for people under the Department of Transportation's hours-of-service limits. Some meals are not limited, for example meals treated as wages to an employee, recreational events for employees and meals you sell or give to the public as advertising (Pub. 463). This worksheet takes ${mealsPercent}% of what is booked to line 24b, rounding half a cent away from zero, and shows what it took off. Check the percentage, and that the account holds only meals, with whoever prepares your return. Entertainment does not go on this line.${
          context.taxYear >= 2026
            ? " The 2026 instructions are not published yet; this is the rule in the 2025 instructions."
            : ""
        }`,
        SOURCES.scheduleCInstructions,
        SOURCES.pub463,
      ),
      note(
        "salesTax",
        "Sales tax you collect. Your books hold sales tax collected from customers in a liability account, so it is not in gross receipts (line 1) here. The Schedule C instructions (line 23) say state and local sales taxes imposed on the buyer, which you collect and pay over, are not included in gross receipts or sales and are not deductible, and that any part the state lets you keep is income on line 6. They also say that sales tax imposed on you as the seller, if you collected it from the buyer, is included in gross receipts on line 1 and deductible on line 23. Which applies depends on the tax in your state. Rastrata does not know.",
        SOURCES.scheduleCInstructions,
      ),
      note(
        "returns",
        "Returns and allowances (line 2) are shown as a positive number, as the instructions ask.",
        SOURCES.scheduleCInstructions,
      ),
      note(
        "inventory",
        "Inventory. Rastrata does not value inventory: lines 35 and 41 are shown as 0.00 and line 42 is the sum of lines 36 to 39. The instructions say that in most cases a business whose income depends on making or selling merchandise must take inventories at the start and end of the year, with an exception for small business taxpayers. If you keep an inventory, the cost of goods sold becomes line 35 plus lines 36 to 39, less line 41.",
        SOURCES.scheduleCInstructions,
      ),
      note(
        "loss",
        "Net profit or (loss) on line 31 is arithmetic here: line 29 less line 30. The instructions say a loss may be limited by the at-risk and passive activity rules (Form 6198 and Form 8582). This worksheet applies neither.",
        SOURCES.scheduleCInstructions,
      ),
    );
  } else {
    const who = form === "form1120S" ? "corporation" : "partnership";
    const line = form === "form1120S" ? "20" : "21";
    const source =
      form === "form1120S" ? SOURCES.form1120SInstructions : SOURCES.form1065Instructions;
    notes.push(
      note(
        "otherDeductions",
        `Other deductions (line ${line}). The instructions say to attach a statement listing by type and amount each deduction included on this line, and give insurance premiums, legal and professional fees, supplies, utilities, and travel, meals and entertainment among the examples. Each account tagged to line ${line} is listed with its amount so you can build that statement.`,
        source,
      ),
      note(
        "meals",
        `Meals. The instructions say the ${who} can generally deduct only 50% of the amount otherwise allowable for meals${
          form === "form1065" ? " (entertainment-related meals are generally disallowed)" : ""
        }. The books record the full cost, and this worksheet does not apply the limit because meals share line ${line} with other costs. If an account holds only meals, take 50% of it, or ask whoever prepares the return.`,
        source,
      ),
      note(
        "inventory",
        "Inventory. Rastrata does not value inventory: Form 1125-A lines 1 and 7 are shown as 0.00 and the cost of goods sold is the sum of lines 2 to 5. If you keep an inventory, it becomes line 6 less line 7.",
        {
          title: "Form 1125-A (Rev. November 2024), Cost of Goods Sold",
          url: "https://www.irs.gov/pub/irs-pdf/f1125a.pdf",
          readOn: TAX_RULES_READ_ON,
        },
      ),
      note(
        "separatelyStated",
        "Items that are stated separately to the owners, such as charitable contributions and interest or dividend income, are not on page 1. Rastrata does not separate them: an account that holds one has no line here and is listed as not mapped.",
      ),
    );
    if (form === "form1065")
      notes.push(
        note(
          "depreciation",
          "Line 16b (depreciation already reported on Form 1125-A and elsewhere on the return) is not tracked, so line 16c equals line 16a here.",
        ),
      );
  }
  notes.push(
    note(
      "method",
      `The book is kept on the ${basis} basis. The return asks which accounting method it uses; the book's basis does not decide that.`,
    ),
  );
  if (context.draft) notes.push(draftNote(form, context.formName));
  return notes;
}

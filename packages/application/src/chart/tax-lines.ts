/** The tax form lines an account can be tagged with, verified against the IRS forms.
 *
 * This is reference data and it is high stakes, so every entry is traced to the printed form:
 * the captions below are the IRS captions with the "(see instructions)" asides removed, and the
 * lane document (docs/reference/program/chart.md) records where and when each form was read.
 * Rastrata books and reports. It does not give tax advice, choose a line for you or file anything:
 * a tag is a suggestion the owner or their preparer confirms against the current form.
 *
 * A line id is `<form>.line<number>` ("scheduleC.line8", "form1120S.line20"). The meaning of a
 * number belongs to a form AND a tax year: line 16b of Schedule C is "Other" interest on the 2025
 * form and "Vehicle loan" interest on the 2026 draft, where "Other" moved to 16c. A tag therefore
 * says "this account feeds that line", and the reader asks this catalog what the line meant in
 * the year it is preparing. Because tags are versioned by effective date, an owner re-tags an
 * account from 1 January when a form renumbers a line.
 *
 * Pure and portable: no `bun:` or `node:` imports. */
import type { AccountRole } from "../contracts.ts";

export type TaxFormId = "scheduleC" | "form1120S" | "form1065" | "form1125A";
export type TaxLineKind = "income" | "costOfGoods" | "expense";
export type TaxFormStatus = "final" | "draft";

export interface TaxLine {
  /** "scheduleC.line16c". */
  readonly id: string;
  /** The printed line number, for example "16c". */
  readonly number: string;
  /** The IRS caption, without "(see instructions)" asides. */
  readonly label: string;
  readonly part: string;
  readonly kind: TaxLineKind;
  /** The account roles whose balances can feed this line. */
  readonly roles: readonly AccountRole[];
  /** Plain guidance shown beside the line. Never advice; says what the instructions say. */
  readonly note?: string;
}

export interface TaxSource {
  readonly title: string;
  readonly url: string;
}

export interface TaxForm {
  readonly id: TaxFormId;
  /** For example "Schedule C (Form 1040)". */
  readonly name: string;
  /** The IRS title of the form. */
  readonly subject: string;
  readonly taxYear: number;
  /** "draft" is an IRS early-release draft: IRS says the final form does not change from the
   * last posted draft unless legislation intervenes, but it is still not the filed form. */
  readonly status: TaxFormStatus;
  /** The day the form and its instructions were read on IRS.gov. */
  readonly verifiedOn: string;
  readonly sources: readonly TaxSource[];
  readonly lines: readonly TaxLine[];
}

export const TAX_DISCLAIMER =
  "Tax lines are suggestions taken from the IRS form. Verify against the current form; not tax advice.";

/** The tax years the catalog covers: 2025 is the final IRS form and 2026 is the IRS draft. */
export const TAX_YEARS: readonly number[] = [2025, 2026];
export const LATEST_TAX_YEAR = 2026;
const VERIFIED_ON = "2026-10-03";

const INCOME: readonly AccountRole[] = ["income", "gain"];
const CONTRA_INCOME: readonly AccountRole[] = ["income", "expense"];
const EXPENSE: readonly AccountRole[] = ["expense"];

function line(
  form: TaxFormId,
  number: string,
  label: string,
  part: string,
  kind: TaxLineKind,
  roles: readonly AccountRole[],
  note?: string,
): TaxLine {
  return {
    id: `${form}.line${number}`,
    number,
    label,
    part,
    kind,
    roles,
    ...(note ? { note } : {}),
  };
}

const sources = (form: TaxFormId, year: number): TaxSource[] => {
  const base = "https://www.irs.gov";
  const final = year === 2025;
  const pdf = (name: string) =>
    `${base}/pub/${final ? "irs-pdf" : "irs-dft"}/${name}${final ? "" : "--dft"}.pdf`;
  switch (form) {
    case "scheduleC":
      return [
        {
          title: `Schedule C (Form 1040) ${year}${final ? "" : ", IRS draft"}`,
          url: pdf("f1040sc"),
        },
        ...(final
          ? [
              {
                title: "Instructions for Schedule C (Form 1040) (2025)",
                url: `${base}/instructions/i1040sc`,
              },
            ]
          : []),
      ];
    case "form1120S":
      return [
        { title: `Form 1120-S ${year}${final ? "" : ", IRS draft"}`, url: pdf("f1120s") },
        ...(final
          ? [{ title: "Instructions for Form 1120-S (2025)", url: `${base}/instructions/i1120s` }]
          : []),
      ];
    case "form1065":
      return [
        { title: `Form 1065 ${year}${final ? "" : ", IRS draft"}`, url: pdf("f1065") },
        ...(final
          ? [{ title: "Instructions for Form 1065 (2025)", url: `${base}/instructions/i1065` }]
          : []),
      ];
    case "form1125A":
      return [
        {
          title: "Form 1125-A (Rev. November 2024), Cost of Goods Sold",
          url: `${base}/pub/irs-pdf/f1125a.pdf`,
        },
      ];
  }
};

const scheduleCExpenses = (year: number): TaxLine[] => [
  line("scheduleC", "8", "Advertising", "Part II", "expense", EXPENSE),
  line("scheduleC", "9", "Car and truck expenses", "Part II", "expense", EXPENSE),
  line(
    "scheduleC",
    "10",
    "Commissions and fees",
    "Part II",
    "expense",
    EXPENSE,
    "The instructions do not name payment-processing fees. They are commonly reported here or in Part V (line 27b); ask your preparer.",
  ),
  line("scheduleC", "11", "Contract labor", "Part II", "expense", EXPENSE),
  line("scheduleC", "12", "Depletion", "Part II", "expense", EXPENSE),
  line(
    "scheduleC",
    "13",
    "Depreciation and section 179 expense deduction (not included in Part III)",
    "Part II",
    "expense",
    EXPENSE,
  ),
  line(
    "scheduleC",
    "14",
    "Employee benefit programs (other than on line 19)",
    "Part II",
    "expense",
    EXPENSE,
  ),
  line("scheduleC", "15", "Insurance (other than health)", "Part II", "expense", EXPENSE),
  line(
    "scheduleC",
    "16a",
    "Interest: Mortgage (paid to banks, etc.)",
    "Part II",
    "expense",
    EXPENSE,
  ),
  ...(year >= 2026
    ? [
        line("scheduleC", "16b", "Interest: Vehicle loan", "Part II", "expense", EXPENSE),
        line("scheduleC", "16c", "Interest: Other", "Part II", "expense", EXPENSE),
      ]
    : [line("scheduleC", "16b", "Interest: Other", "Part II", "expense", EXPENSE)]),
  line("scheduleC", "17", "Legal and professional services", "Part II", "expense", EXPENSE),
  line("scheduleC", "18", "Office expense", "Part II", "expense", EXPENSE),
  line("scheduleC", "19", "Pension and profit-sharing plans", "Part II", "expense", EXPENSE),
  line(
    "scheduleC",
    "20a",
    "Rent or lease: Vehicles, machinery, and equipment",
    "Part II",
    "expense",
    EXPENSE,
  ),
  line("scheduleC", "20b", "Rent or lease: Other business property", "Part II", "expense", EXPENSE),
  line("scheduleC", "21", "Repairs and maintenance", "Part II", "expense", EXPENSE),
  line("scheduleC", "22", "Supplies (not included in Part III)", "Part II", "expense", EXPENSE),
  line("scheduleC", "23", "Taxes and licenses", "Part II", "expense", EXPENSE),
  line("scheduleC", "24a", "Travel and meals: Travel", "Part II", "expense", EXPENSE),
  line(
    "scheduleC",
    "24b",
    "Travel and meals: Deductible meals",
    "Part II",
    "expense",
    EXPENSE,
    "Business meals are generally 50% deductible; the tax worksheet applies the percentage, the books record the full cost.",
  ),
  line("scheduleC", "25", "Utilities", "Part II", "expense", EXPENSE),
  line("scheduleC", "26", "Wages (less employment credits)", "Part II", "expense", EXPENSE),
  line(
    "scheduleC",
    "27a",
    "Energy efficient commercial bldgs deduction (attach Form 7205)",
    "Part II",
    "expense",
    EXPENSE,
  ),
  line(
    "scheduleC",
    "27b",
    "Other expenses (from line 48)",
    "Part II",
    "expense",
    EXPENSE,
    year >= 2025
      ? "Part V total. Before tax year 2025 this was line 27a; 27a is now the energy efficient commercial buildings deduction."
      : undefined,
  ),
  line(
    "scheduleC",
    "30",
    "Expenses for business use of your home",
    "Part II",
    "expense",
    EXPENSE,
    "Use only for the home-office total. Form 8829 or the simplified method may be required.",
  ),
];

const scheduleCLines = (year: number): TaxLine[] => [
  line("scheduleC", "1", "Gross receipts or sales", "Part I", "income", INCOME),
  line("scheduleC", "2", "Returns and allowances", "Part I", "income", CONTRA_INCOME),
  line(
    "scheduleC",
    "6",
    "Other income, including federal and state gasoline or fuel tax credit or refund",
    "Part I",
    "income",
    INCOME,
  ),
  ...scheduleCExpenses(year),
  line(
    "scheduleC",
    "36",
    "Purchases less cost of items withdrawn for personal use",
    "Part III",
    "costOfGoods",
    EXPENSE,
  ),
  line(
    "scheduleC",
    "37",
    "Cost of labor (do not include any amounts paid to yourself)",
    "Part III",
    "costOfGoods",
    EXPENSE,
  ),
  line("scheduleC", "38", "Materials and supplies", "Part III", "costOfGoods", EXPENSE),
  line("scheduleC", "39", "Other costs", "Part III", "costOfGoods", EXPENSE),
];

const form1120SLines = (): TaxLine[] => [
  line("form1120S", "1a", "Gross receipts or sales", "Income", "income", INCOME),
  line("form1120S", "1b", "Less returns and allowances", "Income", "income", CONTRA_INCOME),
  line(
    "form1120S",
    "2",
    "Cost of goods sold (attach Form 1125-A)",
    "Income",
    "costOfGoods",
    EXPENSE,
    "The total comes from Form 1125-A, line 8. Tag the detail accounts with Form 1125-A lines instead.",
  ),
  line(
    "form1120S",
    "4",
    "Net gain (loss) from Form 4797 (attach Form 4797)",
    "Income",
    "income",
    INCOME,
  ),
  line("form1120S", "5", "Other income (loss)", "Income", "income", INCOME),
  line(
    "form1120S",
    "7",
    "Compensation of officers (attach Form 1125-E)",
    "Deductions",
    "expense",
    EXPENSE,
  ),
  line(
    "form1120S",
    "8",
    "Salaries and wages (less employment credits)",
    "Deductions",
    "expense",
    EXPENSE,
  ),
  line("form1120S", "9", "Repairs and maintenance", "Deductions", "expense", EXPENSE),
  line("form1120S", "10", "Bad debts", "Deductions", "expense", EXPENSE),
  line("form1120S", "11", "Rents", "Deductions", "expense", EXPENSE),
  line("form1120S", "12", "Taxes and licenses", "Deductions", "expense", EXPENSE),
  line("form1120S", "13", "Interest", "Deductions", "expense", EXPENSE),
  line(
    "form1120S",
    "14",
    "Depreciation from Form 4562 not claimed on Form 1125-A or elsewhere on return",
    "Deductions",
    "expense",
    EXPENSE,
  ),
  line("form1120S", "15", "Depletion", "Deductions", "expense", EXPENSE),
  line("form1120S", "16", "Advertising", "Deductions", "expense", EXPENSE),
  line("form1120S", "17", "Pension, profit-sharing, etc., plans", "Deductions", "expense", EXPENSE),
  line("form1120S", "18", "Employee benefit programs", "Deductions", "expense", EXPENSE),
  line(
    "form1120S",
    "19",
    "Energy efficient commercial buildings deduction (attach Form 7205)",
    "Deductions",
    "expense",
    EXPENSE,
  ),
  line(
    "form1120S",
    "20",
    "Other deductions (attach statement)",
    "Deductions",
    "expense",
    EXPENSE,
    "The instructions list insurance, legal and professional fees, supplies, travel, meals, utilities and amortization here, each itemised on an attached statement.",
  ),
];

const form1065Lines = (): TaxLine[] => [
  line("form1065", "1a", "Gross receipts or sales", "Income", "income", INCOME),
  line("form1065", "1b", "Less returns and allowances", "Income", "income", CONTRA_INCOME),
  line(
    "form1065",
    "2",
    "Cost of goods sold (attach Form 1125-A)",
    "Income",
    "costOfGoods",
    EXPENSE,
    "The total comes from Form 1125-A, line 8. Tag the detail accounts with Form 1125-A lines instead.",
  ),
  line(
    "form1065",
    "6",
    "Net gain (loss) from Form 4797 (attach Form 4797)",
    "Income",
    "income",
    INCOME,
  ),
  line("form1065", "7", "Other income (loss)", "Income", "income", INCOME),
  line(
    "form1065",
    "9",
    "Salaries and wages (other than to partners) (less employment credits)",
    "Deductions",
    "expense",
    EXPENSE,
  ),
  line(
    "form1065",
    "10",
    "Guaranteed payments to partners",
    "Deductions",
    "expense",
    EXPENSE,
    "Payments to a partner for services or capital that do not depend on partnership income, including medical insurance for a partner.",
  ),
  line("form1065", "11", "Repairs and maintenance", "Deductions", "expense", EXPENSE),
  line("form1065", "12", "Bad debts", "Deductions", "expense", EXPENSE),
  line("form1065", "13", "Rent", "Deductions", "expense", EXPENSE),
  line("form1065", "14", "Taxes and licenses", "Deductions", "expense", EXPENSE),
  line("form1065", "15", "Interest", "Deductions", "expense", EXPENSE),
  line(
    "form1065",
    "16a",
    "Depreciation (if required, attach Form 4562)",
    "Deductions",
    "expense",
    EXPENSE,
  ),
  line("form1065", "17", "Depletion", "Deductions", "expense", EXPENSE),
  line("form1065", "18", "Retirement plans, etc.", "Deductions", "expense", EXPENSE),
  line("form1065", "19", "Employee benefit programs", "Deductions", "expense", EXPENSE),
  line(
    "form1065",
    "20",
    "Energy efficient commercial buildings deduction (attach Form 7205)",
    "Deductions",
    "expense",
    EXPENSE,
  ),
  line(
    "form1065",
    "21",
    "Other deductions (attach statement)",
    "Deductions",
    "expense",
    EXPENSE,
    "The instructions list insurance, legal and professional fees, supplies, utilities and amortization here, each itemised on an attached statement.",
  ),
];

const form1125ALines = (): TaxLine[] => [
  line("form1125A", "2", "Purchases", "Cost of Goods Sold", "costOfGoods", EXPENSE),
  line("form1125A", "3", "Cost of labor", "Cost of Goods Sold", "costOfGoods", EXPENSE),
  line(
    "form1125A",
    "4",
    "Additional section 263A costs (attach schedule)",
    "Cost of Goods Sold",
    "costOfGoods",
    EXPENSE,
  ),
  line(
    "form1125A",
    "5",
    "Other costs (attach schedule)",
    "Cost of Goods Sold",
    "costOfGoods",
    EXPENSE,
  ),
];

const FORM_NAMES: Readonly<Record<TaxFormId, { name: string; subject: string }>> = {
  scheduleC: {
    name: "Schedule C (Form 1040)",
    subject: "Profit or Loss From Business (Sole Proprietorship)",
  },
  form1120S: { name: "Form 1120-S", subject: "U.S. Income Tax Return for an S Corporation" },
  form1065: { name: "Form 1065", subject: "U.S. Return of Partnership Income" },
  form1125A: { name: "Form 1125-A", subject: "Cost of Goods Sold" },
};

/** The short name a person says out loud: "Schedule C", for a badge beside a template. */
export const TAX_FORM_SHORT_NAMES: Readonly<Record<TaxFormId, string>> = {
  scheduleC: "Schedule C",
  form1120S: "Form 1120-S",
  form1065: "Form 1065",
  form1125A: "Form 1125-A",
};

export const TAX_FORM_IDS: readonly TaxFormId[] = [
  "scheduleC",
  "form1120S",
  "form1065",
  "form1125A",
];

function build(formId: TaxFormId, taxYear: number): TaxForm {
  const lines =
    formId === "scheduleC"
      ? scheduleCLines(taxYear)
      : formId === "form1120S"
        ? form1120SLines()
        : formId === "form1065"
          ? form1065Lines()
          : form1125ALines();
  return {
    id: formId,
    ...FORM_NAMES[formId],
    taxYear,
    // Form 1125-A is the same Rev. November 2024 revision for both years and is final.
    status: formId === "form1125A" || taxYear === 2025 ? "final" : "draft",
    verifiedOn: VERIFIED_ON,
    sources: sources(formId, taxYear),
    lines,
  };
}

const forms: ReadonlyMap<string, TaxForm> = new Map(
  TAX_YEARS.flatMap((year) =>
    TAX_FORM_IDS.map((id) => [`${id}:${year}`, build(id, year)] as const),
  ),
);

export function isTaxYear(value: number): boolean {
  return TAX_YEARS.includes(value);
}

/** One form as it reads in one tax year, or undefined when the catalog does not cover it. */
export function taxForm(formId: TaxFormId, taxYear: number): TaxForm | undefined {
  return forms.get(`${formId}:${taxYear}`);
}

/** Every form for a tax year, in a stable order. */
export function taxForms(taxYear: number): readonly TaxForm[] {
  return TAX_FORM_IDS.flatMap((id) => {
    const form = forms.get(`${id}:${taxYear}`);
    return form ? [form] : [];
  });
}

export function isTaxFormId(value: string): value is TaxFormId {
  return (TAX_FORM_IDS as readonly string[]).includes(value);
}

/** The form id of a line id, for example "scheduleC" for "scheduleC.line8". */
export function formOfLine(lineId: string): TaxFormId | undefined {
  const form = lineId.split(".")[0] ?? "";
  return isTaxFormId(form) ? form : undefined;
}

/** A line as it reads in one tax year. */
export function taxLineIn(lineId: string, taxYear: number): TaxLine | undefined {
  const form = formOfLine(lineId);
  return form ? taxForm(form, taxYear)?.lines.find((item) => item.id === lineId) : undefined;
}

/** A line id that exists in at least one covered tax year. A tag outlives the year it was made
 * in, so an earlier year's line stays valid; its meaning is read per year with `taxLineIn`. */
export function knownTaxLine(lineId: string): TaxLine | undefined {
  for (const year of [...TAX_YEARS].reverse()) {
    const found = taxLineIn(lineId, year);
    if (found) return found;
  }
  return undefined;
}

/** True when an account with this role may feed the line. */
export function lineAcceptsRole(lineId: string, role: AccountRole): boolean {
  return TAX_YEARS.some((year) => taxLineIn(lineId, year)?.roles.includes(role));
}

/** The year to show when a caller has none, or has one the catalog does not cover: the covered
 * year closest to the one asked for. */
export function nearestTaxYear(requested?: number): number {
  if (requested === undefined) return LATEST_TAX_YEAR;
  const first = TAX_YEARS[0] ?? LATEST_TAX_YEAR;
  return requested < first ? first : requested > LATEST_TAX_YEAR ? LATEST_TAX_YEAR : requested;
}

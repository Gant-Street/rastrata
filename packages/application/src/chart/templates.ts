/** Chart templates: a starting chart of accounts for the entity types a US small business is,
 * each with the account roles, the cash-flow class of every balance-sheet account and the tax line
 * of every income, cost and expense account.
 *
 * A template is data. `buildTemplate` turns it into a chart a book can be set up with: it keeps
 * only the accounts that belong on the chosen accounting basis, adds the chosen add-ons, and
 * resolves each account's tax line against the form as it reads in the chosen tax year. Tax lines
 * are verified against the IRS forms (see tax-lines.ts and docs/reference/program/chart.md) and are
 * suggestions: verify against the current form; not tax advice.
 *
 * Pure and portable: no `bun:` or `node:` imports. */
import type { AccountTags, CashFlowClass } from "../account-tags.ts";
import type { AccountRole } from "../contracts.ts";
import { CATCHALL_EXPENSE, CATCHALL_INCOME, validateChartTags } from "./tags.ts";
import { TAX_DISCLAIMER, taxForm, type TaxForm, type TaxFormId } from "./tax-lines.ts";

export type EntityKind = "soleProprietor" | "sCorporation" | "partnership" | "generic";
export type TemplateBasis = "cash" | "accrual";

/** The line an account feeds. A bare number is a line of the template's own form; a full id
 * ("form1125A.line2") names another form; `byYear` is for a number a form moved between years;
 * `byForm` is for add-on accounts, whose line depends on the entity's form. */
export type TaxSpec =
  | string
  | { readonly byYear: Readonly<Record<number, string>> }
  | { readonly byForm: Readonly<Partial<Record<TaxFormId, string>>> };

export interface AccountSpec {
  readonly code: string;
  readonly name: string;
  readonly role: AccountRole;
  readonly parent?: string;
  /** Balance-sheet accounts only. */
  readonly flow?: CashFlowClass;
  readonly tax?: TaxSpec;
  readonly roleKey?: string;
  /** Only on accrual books: cash-basis books never record these. */
  readonly accrual?: true;
  /** What belongs in the account, in a sentence. */
  readonly note?: string;
}

export interface TemplateSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly entity: EntityKind;
  /** The return the template's tax lines belong to. Absent: no tax mapping. */
  readonly form?: TaxFormId;
  /** Other forms its accounts feed, shown beside the return (Form 1125-A for cost of goods sold). */
  readonly attached?: readonly TaxFormId[];
  readonly notes: readonly string[];
  readonly accounts: readonly AccountSpec[];
}

export interface AddOnSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly notes: readonly string[];
  readonly accounts: readonly AccountSpec[];
}

/** One account of a built chart: a valid `InitialAccount` plus what the screens show beside it. */
export interface BuiltAccount {
  readonly code: string;
  readonly name: string;
  readonly role: AccountRole;
  readonly parentCode?: string;
  readonly tags: AccountTags;
  readonly note?: string;
}

export interface BuiltTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly entity: EntityKind;
  /** The return the tax lines belong to, then any attached forms; empty without a tax mapping. */
  readonly taxForms: readonly TaxForm[];
  readonly taxYear: number | null;
  readonly basis: TemplateBasis;
  readonly addOns: readonly string[];
  readonly disclaimer: string;
  readonly notes: readonly string[];
  readonly accounts: readonly BuiltAccount[];
}

type Extra = Partial<AccountSpec>;
const bank = (code: string, name: string, extra: Extra = {}): AccountSpec => ({
  code,
  name,
  role: "asset",
  flow: "cash",
  ...extra,
});
const asset = (
  code: string,
  name: string,
  flow: CashFlowClass,
  extra: Extra = {},
): AccountSpec => ({
  code,
  name,
  role: "asset",
  flow,
  ...extra,
});
const liability = (
  code: string,
  name: string,
  flow: CashFlowClass,
  extra: Extra = {},
): AccountSpec => ({ code, name, role: "liability", flow, ...extra });
const equity = (code: string, name: string, extra: Extra = {}): AccountSpec => ({
  code,
  name,
  role: "equity",
  flow: "financing",
  ...extra,
});
const income = (code: string, name: string, tax?: TaxSpec, extra: Extra = {}): AccountSpec => ({
  code,
  name,
  role: "income",
  ...(tax !== undefined ? { tax } : {}),
  ...extra,
});
const expense = (code: string, name: string, tax?: TaxSpec, extra: Extra = {}): AccountSpec => ({
  code,
  name,
  role: "expense",
  ...(tax !== undefined ? { tax } : {}),
  ...extra,
});

const MEALS_NOTE =
  "Record the full cost; the deductible percentage is applied when the return is prepared.";
const REFUNDS_NOTE =
  "Refunds and price allowances. Record them as debits: they show as negative revenue.";
const REVENUE_NOTE = "Gross sales, before refunds, fees and sales tax.";
const CATCHALL_EXPENSE_NOTE =
  "For expenses that fit nowhere else. At month end Rastrata tells you how much is here, so you can move it to a better account.";
const CATCHALL_INCOME_NOTE =
  "For income that fits nowhere else. At month end Rastrata tells you how much is here, so you can move it to a better account.";
const SPLIT_NOTE =
  "Earnings of earlier years. Rastrata computes the current year from the profit and loss and does not post closing entries.";

// Balance-sheet accounts every entity starts with, before its own equity. A template carries no bank or
// card account: those are the person's own, made from what they bring (a bank they connect, a statement
// they import, a history they bring in) and named by the bank, never typed ahead of time (ruling of
// 2026-11-05). Their codes are the 1000s and 2000s, which the templates leave free.
const currentAssets: AccountSpec[] = [
  asset("1200", "Accounts receivable", "operating", {
    accrual: true,
    note: "Money customers owe you for sales you have not been paid for.",
  }),
  asset("1300", "Inventory", "operating", {
    note: "Goods held for sale. Rastrata does not value inventory: record the count at year end with a journal.",
  }),
  asset("1400", "Prepaid expenses", "operating", { accrual: true }),
];
const fixedAssets: AccountSpec[] = [
  asset("1500", "Equipment and computers", "investing", { note: "At cost." }),
  asset("1590", "Accumulated depreciation", "noncash", {
    note: "Depreciation recorded so far on equipment. It has a credit balance.",
  }),
];
const cardAndPayables: AccountSpec[] = [
  liability("2100", "Accounts payable", "operating", {
    accrual: true,
    note: "Bills you have received and not paid.",
  }),
  liability("2200", "Payroll liabilities", "operating", {
    note: "Wages and payroll taxes withheld or owed and not yet paid.",
  }),
  liability("2300", "Loans payable", "financing"),
];
const openingBalance = equity("3900", "Opening balance equity", {
  note: "The offset for starting balances brought from another system.",
});

const incomeAccounts = (sales?: TaxSpec, returns?: TaxSpec, other?: TaxSpec): AccountSpec[] => [
  income("4000", "Sales", sales, { note: REVENUE_NOTE }),
  income("4100", "Returns and allowances", returns, { note: REFUNDS_NOTE }),
  income("4900", "Other income", other, { roleKey: CATCHALL_INCOME, note: CATCHALL_INCOME_NOTE }),
];

export const TEMPLATES: readonly TemplateSpec[] = [
  {
    id: "sole-proprietor",
    name: "Sole proprietor or single-member LLC",
    description:
      "For a business reported on Schedule C (Form 1040): owner's investment and draw, cost of goods sold, and every common Schedule C expense.",
    entity: "soleProprietor",
    form: "scheduleC",
    notes: [
      "A sole proprietor, or a single-member LLC that has not elected to be taxed as a corporation, reports business income and expenses on Schedule C.",
      "Money you take out is an owner's draw, not an expense. That includes personal income tax and self-employment tax paid from the business account.",
      "Most Schedule C filers keep their books on a calendar year.",
    ],
    accounts: [
      ...currentAssets,
      ...fixedAssets,
      ...cardAndPayables,
      equity("3000", "Owner's investment", { note: "Money you put into the business." }),
      equity("3100", "Owner's draw", {
        note: "Money you take out for yourself. Not a business expense.",
      }),
      openingBalance,
      ...incomeAccounts("1", "2", "6"),
      expense("5000", "Cost of goods sold: Purchases", "36"),
      expense("5100", "Cost of goods sold: Cost of labor", "37"),
      expense("5200", "Cost of goods sold: Materials and supplies", "38"),
      expense("5900", "Cost of goods sold: Other costs", "39"),
      expense("6000", "Advertising and marketing", "8"),
      expense("6010", "Car and truck expenses", "9"),
      expense("6020", "Commissions and fees", "10"),
      expense("6030", "Contract labor", "11", {
        note: "Payments to people who are not your employees.",
      }),
      expense("6040", "Depreciation", "13"),
      expense("6060", "Insurance (other than health)", "15"),
      expense("6070", "Interest expense", { byYear: { 2025: "16b", 2026: "16c" } }),
      expense("6080", "Legal and professional services", "17"),
      expense("6090", "Office expense", "18", { note: "Office supplies and postage." }),
      expense("6110", "Rent or lease: Equipment", "20a"),
      expense("6120", "Rent or lease: Office space", "20b"),
      expense("6130", "Repairs and maintenance", "21"),
      expense("6140", "Supplies", "22"),
      expense("6150", "Taxes and licenses", "23"),
      expense("6160", "Travel", "24a"),
      expense("6170", "Meals", "24b", { note: MEALS_NOTE }),
      expense("6180", "Utilities", "25"),
      expense("6190", "Wages", "26"),
      expense("6200", "Software and subscriptions", "27b"),
      expense("6210", "Bank and card fees", "27b"),
      expense("6290", "Other expenses", "27b", {
        roleKey: CATCHALL_EXPENSE,
        note: CATCHALL_EXPENSE_NOTE,
      }),
    ],
  },
  {
    id: "s-corporation",
    name: "S corporation",
    description:
      "For a corporation, or an LLC, that has elected S status and files Form 1120-S: officer compensation, shareholder distributions and loans, retained earnings.",
    entity: "sCorporation",
    form: "form1120S",
    attached: ["form1125A"],
    notes: [
      "The Form 1120-S instructions say payments to an officer must be treated as wages to the extent they are reasonable compensation for services. Distributions to shareholders are not expenses.",
      "Form 1120-S has separate lines for officer compensation, salaries, repairs, bad debts, rent, taxes, interest, depreciation, advertising, retirement plans and benefits. Insurance, legal fees, supplies, utilities, travel and meals are itemised under Other deductions (line 20).",
      "Cost of goods sold is detailed on Form 1125-A.",
    ],
    accounts: [
      ...currentAssets,
      ...fixedAssets,
      ...cardAndPayables,
      liability("2400", "Loans from shareholders", "financing"),
      equity("3000", "Common stock", { note: "Money shareholders paid in for their shares." }),
      equity("3100", "Additional paid-in capital"),
      equity("3200", "Shareholder distributions", {
        note: "Money paid out to shareholders as owners. Not an expense.",
      }),
      equity("3300", "Retained earnings", { note: SPLIT_NOTE }),
      openingBalance,
      ...incomeAccounts("1a", "1b", "5"),
      expense("5000", "Cost of goods sold: Purchases", "form1125A.line2"),
      expense("5100", "Cost of goods sold: Cost of labor", "form1125A.line3"),
      expense("5900", "Cost of goods sold: Other costs", "form1125A.line5"),
      expense("6000", "Officer compensation", "7"),
      expense("6010", "Salaries and wages", "8"),
      expense("6020", "Repairs and maintenance", "9"),
      expense("6030", "Bad debts", "10"),
      expense("6040", "Rent", "11"),
      expense("6050", "Taxes and licenses", "12", {
        note: "Include the employer's payroll taxes.",
      }),
      expense("6060", "Interest expense", "13"),
      expense("6070", "Depreciation", "14"),
      expense("6080", "Advertising and marketing", "16"),
      expense("6090", "Retirement plan contributions", "17"),
      expense("6100", "Employee benefit programs", "18"),
      expense("6200", "Insurance", "20"),
      expense("6210", "Legal and professional fees", "20"),
      expense("6220", "Office expense", "20"),
      expense("6230", "Supplies", "20"),
      expense("6240", "Utilities", "20"),
      expense("6250", "Travel", "20"),
      expense("6260", "Meals", "20", { note: MEALS_NOTE }),
      expense("6270", "Software and subscriptions", "20"),
      expense("6280", "Bank and card fees", "20"),
      expense("6290", "Contract labor", "20"),
      expense("6299", "Other deductions", "20", {
        roleKey: CATCHALL_EXPENSE,
        note: CATCHALL_EXPENSE_NOTE,
      }),
    ],
  },
  {
    id: "partnership",
    name: "Partnership or multi-member LLC",
    description:
      "For a partnership, or an LLC with more than one member, that files Form 1065: partners' capital and distributions, guaranteed payments.",
    entity: "partnership",
    form: "form1065",
    attached: ["form1125A"],
    notes: [
      "Add a capital account for each partner under Partners' capital contributions and Partners' distributions so each partner's share is visible.",
      "Payments to a partner for services or for the use of capital that are determined without regard to partnership income are guaranteed payments (line 10).",
      "Form 1065 has no separate lines for advertising, insurance, legal fees, supplies, utilities, travel or meals: they are itemised under Other deductions (line 21).",
      "Cost of goods sold is detailed on Form 1125-A.",
    ],
    accounts: [
      ...currentAssets,
      ...fixedAssets,
      ...cardAndPayables,
      equity("3000", "Partners' capital contributions", {
        note: "Money partners put into the business. Add one account per partner.",
      }),
      equity("3100", "Partners' distributions", {
        note: "Money paid out to partners as owners. Not an expense. Add one account per partner.",
      }),
      openingBalance,
      ...incomeAccounts("1a", "1b", "7"),
      expense("5000", "Cost of goods sold: Purchases", "form1125A.line2"),
      expense("5100", "Cost of goods sold: Cost of labor", "form1125A.line3"),
      expense("5900", "Cost of goods sold: Other costs", "form1125A.line5"),
      expense("6000", "Salaries and wages (other than to partners)", "9"),
      expense("6010", "Guaranteed payments to partners", "10"),
      expense("6020", "Repairs and maintenance", "11"),
      expense("6030", "Bad debts", "12"),
      expense("6040", "Rent", "13"),
      expense("6050", "Taxes and licenses", "14", {
        note: "Include the employer's payroll taxes.",
      }),
      expense("6060", "Interest expense", "15"),
      expense("6070", "Depreciation", "16a"),
      expense("6090", "Retirement plan contributions", "18"),
      expense("6100", "Employee benefit programs", "19"),
      expense("6200", "Advertising and marketing", "21"),
      expense("6210", "Insurance", "21"),
      expense("6220", "Legal and professional fees", "21"),
      expense("6230", "Office expense", "21"),
      expense("6240", "Supplies", "21"),
      expense("6250", "Utilities", "21"),
      expense("6260", "Travel", "21"),
      expense("6270", "Meals", "21", { note: MEALS_NOTE }),
      expense("6280", "Software and subscriptions", "21"),
      expense("6285", "Bank and card fees", "21"),
      expense("6290", "Contract labor", "21"),
      expense("6299", "Other deductions", "21", {
        roleKey: CATCHALL_EXPENSE,
        note: CATCHALL_EXPENSE_NOTE,
      }),
    ],
  },
  {
    id: "generic",
    name: "Other business",
    description:
      "A plain chart for any small business, with no tax form mapping. Use it when your entity is not one of the others, or outside the United States.",
    entity: "generic",
    notes: [
      "This chart carries cash-flow classes but no tax lines. Choose the template for your entity to get tax lines for a US return.",
    ],
    accounts: [
      ...currentAssets,
      ...fixedAssets,
      ...cardAndPayables,
      equity("3000", "Owner's equity", { note: "Money the owners put into the business." }),
      equity("3100", "Owner's draws and distributions", {
        note: "Money the owners take out. Not an expense.",
      }),
      equity("3200", "Retained earnings", { note: SPLIT_NOTE }),
      openingBalance,
      ...incomeAccounts(),
      expense("5000", "Cost of goods sold"),
      expense("6000", "Advertising and marketing"),
      expense("6010", "Bank and card fees"),
      expense("6020", "Contract labor"),
      expense("6030", "Depreciation"),
      expense("6040", "Insurance"),
      expense("6050", "Interest expense"),
      expense("6060", "Legal and professional fees"),
      expense("6070", "Meals", undefined, { note: MEALS_NOTE }),
      expense("6080", "Office expense"),
      expense("6090", "Payroll taxes"),
      expense("6100", "Rent"),
      expense("6110", "Repairs and maintenance"),
      expense("6120", "Software and subscriptions"),
      expense("6130", "Supplies"),
      expense("6140", "Taxes and licenses"),
      expense("6150", "Travel"),
      expense("6160", "Utilities"),
      expense("6170", "Wages"),
      expense("6290", "Other expenses", undefined, {
        roleKey: CATCHALL_EXPENSE,
        note: CATCHALL_EXPENSE_NOTE,
      }),
    ],
  },
];

/** The role keys the Stripe lane maps by (the cross-lane contract). */
export const STRIPE_ROLE_KEYS: readonly string[] = [
  "stripe.balance",
  "stripe.fees",
  "payouts.in-transit",
  "refunds",
  "chargebacks",
  "tax.sales",
  "revenue.sales",
];

export const ADD_ONS: readonly AddOnSpec[] = [
  {
    id: "online-business",
    name: "Online business (Stripe)",
    description:
      "Accounts for taking payments through Stripe: the Stripe balance, payouts on their way to the bank, fees, refunds, chargebacks and sales tax.",
    notes: [
      "Each account carries a role key (stripe.balance, stripe.fees, payouts.in-transit, refunds, chargebacks, tax.sales, revenue.sales) so the Stripe connection can find it, whatever you rename it.",
      "Sales and Returns and allowances are in every template already; the add-on only marks them with their role keys.",
      "Remove Sales tax payable if you do not collect sales tax.",
    ],
    accounts: [
      bank("1100", "Stripe balance", {
        roleKey: "stripe.balance",
        note: "Money Stripe holds for you, available and pending.",
      }),
      bank("1110", "Stripe payouts in transit", {
        roleKey: "payouts.in-transit",
        note: "Payouts Stripe has sent that have not reached your bank yet.",
      }),
      liability("2500", "Sales tax payable", "operating", {
        roleKey: "tax.sales",
        note: "Sales tax collected from customers and owed to the state.",
      }),
      liability("2600", "Deferred revenue", "operating", {
        accrual: true,
        note: "Subscription or prepaid revenue you have been paid for and not yet earned.",
      }),
      income("4000", "Sales", undefined, { roleKey: "revenue.sales" }),
      income("4100", "Returns and allowances", undefined, { roleKey: "refunds" }),
      expense(
        "6025",
        "Stripe fees",
        { byForm: { scheduleC: "10", form1120S: "20", form1065: "21" } },
        {
          roleKey: "stripe.fees",
          note: "Processing fees Stripe takes from each charge. Some preparers report them on Schedule C line 27b instead of line 10: ask yours.",
        },
      ),
      expense(
        "6026",
        "Chargebacks and disputes",
        { byForm: { scheduleC: "27b", form1120S: "20", form1065: "21" } },
        {
          roleKey: "chargebacks",
          note: "Payments customers reversed through their bank, and dispute fees.",
        },
      ),
    ],
  },
];

export const templateSpec = (id: string): TemplateSpec | undefined =>
  TEMPLATES.find((item) => item.id === id);
export const addOnSpec = (id: string): AddOnSpec | undefined =>
  ADD_ONS.find((item) => item.id === id);

/** The full line id an account feeds on a given form and year, or undefined when it feeds none. */
function resolveTax(
  spec: TaxSpec | undefined,
  form: TaxFormId | undefined,
  taxYear: number,
): string | undefined {
  if (spec === undefined || form === undefined) return undefined;
  const number =
    typeof spec === "string" ? spec : "byYear" in spec ? spec.byYear[taxYear] : spec.byForm[form];
  if (number === undefined) return undefined;
  return number.includes(".") ? number : `${form}.line${number}`;
}

export interface BuildOptions {
  readonly addOns?: readonly string[];
  readonly taxYear: number;
  readonly basis: TemplateBasis;
}

/** The chart a book can be set up with: the template's accounts for the basis, the add-ons merged
 * in by code (an account the template already has keeps its name, role and tax line and gains the
 * add-on's role key), and every tax line resolved for the year. Throws on an unknown template or
 * add-on and on any chart that fails the tag rules, so a template that is wrong never reaches a
 * book. */
export function buildTemplate(id: string, options: BuildOptions): BuiltTemplate {
  const spec = templateSpec(id);
  if (!spec) throw new Error(`Unknown template ${id}`);
  const addOns = (options.addOns ?? []).map((addOnId) => {
    const found = addOnSpec(addOnId);
    if (!found) throw new Error(`Unknown add-on ${addOnId}`);
    return found;
  });
  const forms = [spec.form, ...(spec.attached ?? [])].flatMap((formId) => {
    const found = formId ? taxForm(formId, options.taxYear) : undefined;
    return found ? [found] : [];
  });
  const merged = new Map<string, AccountSpec>();
  for (const account of spec.accounts) merged.set(account.code, account);
  for (const addOn of addOns)
    for (const account of addOn.accounts) {
      const existing = merged.get(account.code);
      merged.set(
        account.code,
        existing
          ? { ...existing, ...(account.roleKey ? { roleKey: account.roleKey } : {}) }
          : account,
      );
    }
  const accounts: BuiltAccount[] = [...merged.values()]
    .filter((account) => !account.accrual || options.basis === "accrual")
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((account) => {
      const taxLine = resolveTax(account.tax, spec.form, options.taxYear);
      return {
        code: account.code,
        name: account.name,
        role: account.role,
        ...(account.parent ? { parentCode: account.parent } : {}),
        tags: {
          ...(account.flow ? { cashFlowClass: account.flow } : {}),
          ...(taxLine ? { taxLine } : {}),
          ...(account.roleKey ? { roleKey: account.roleKey } : {}),
        },
        ...(account.note ? { note: account.note } : {}),
      };
    });
  validateChartTags(accounts);
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    entity: spec.entity,
    taxForms: forms,
    taxYear: forms.length > 0 ? options.taxYear : null,
    basis: options.basis,
    addOns: addOns.map((item) => item.id),
    disclaimer: spec.form ? TAX_DISCLAIMER : "",
    notes: [...spec.notes, ...addOns.flatMap((item) => item.notes)],
    accounts,
  };
}

// Fictional data for the chart stories. A stand-in for what the application returns: the same
// shapes and the same kinds of account, so layouts are realistic. No real names, banks or amounts.
import type {
  AccountView,
  AddOnChoice,
  BuiltChart,
  ChartAccount,
  ChartRole,
  SetupChoices,
  TaxFormChoice,
  TemplateChoice,
} from "../../src";
import type { ChartRequest } from "../../src";

export const templates: TemplateChoice[] = [
  { id: "sole-proprietor", name: "Sole proprietor or single-member LLC" },
  { id: "s-corporation", name: "S corporation" },
  { id: "partnership", name: "Partnership or multi-member LLC" },
  { id: "generic", name: "Other business" },
];

export const addOns: AddOnChoice[] = [
  {
    id: "online-business",
    name: "Online business (Stripe)",
    description:
      "Accounts for taking payments through Stripe: the Stripe balance, payouts on their way to the bank, fees, refunds, chargebacks and sales tax.",
  },
];

const expenseLine = (number: string, label: string) => ({
  id: `scheduleC.line${number}`,
  number,
  label,
  part: "Part II",
  roles: ["expense"],
});

export const scheduleC: TaxFormChoice = {
  id: "scheduleC",
  name: "Schedule C (Form 1040)",
  taxYear: 2026,
  status: "draft",
  lines: [
    {
      id: "scheduleC.line1",
      number: "1",
      label: "Gross receipts or sales",
      part: "Part I",
      roles: ["income"],
    },
    {
      id: "scheduleC.line2",
      number: "2",
      label: "Returns and allowances",
      part: "Part I",
      roles: ["income", "expense"],
    },
    {
      id: "scheduleC.line6",
      number: "6",
      label: "Other income",
      part: "Part I",
      roles: ["income"],
    },
    {
      id: "scheduleC.line36",
      number: "36",
      label: "Purchases less cost of items withdrawn for personal use",
      part: "Part III",
      roles: ["expense"],
    },
    {
      id: "scheduleC.line37",
      number: "37",
      label: "Cost of labor",
      part: "Part III",
      roles: ["expense"],
    },
    {
      id: "scheduleC.line38",
      number: "38",
      label: "Materials and supplies",
      part: "Part III",
      roles: ["expense"],
    },
    {
      id: "scheduleC.line39",
      number: "39",
      label: "Other costs",
      part: "Part III",
      roles: ["expense"],
    },
    expenseLine("8", "Advertising"),
    expenseLine("10", "Commissions and fees"),
    expenseLine("11", "Contract labor"),
    expenseLine("13", "Depreciation and section 179 expense deduction (not included in Part III)"),
    expenseLine("15", "Insurance (other than health)"),
    expenseLine("16c", "Interest: Other"),
    expenseLine("17", "Legal and professional services"),
    expenseLine("18", "Office expense"),
    expenseLine("23", "Taxes and licenses"),
    expenseLine("24b", "Travel and meals: Deductible meals"),
    expenseLine("25", "Utilities"),
    expenseLine("26", "Wages (less employment credits)"),
    expenseLine("27b", "Other expenses (from line 48)"),
  ],
};

let counter = 0;
const row = (
  code: string,
  name: string,
  role: ChartRole,
  tags: ChartAccount["tags"] = {},
  extra: Partial<Pick<ChartAccount, "note">> = {},
): ChartAccount => ({ key: `fixture-${++counter}`, code, name, role, tags, ...extra });

/** A chart in the shape the sole proprietor template returns, for the choices asked for. */
export function fixtureChart(request: ChartRequest): BuiltChart {
  counter = 0;
  const accrual = request.basis === "accrual";
  const stripe = request.addOns.includes("online-business");
  const accounts: ChartAccount[] = [
    row(
      "1000",
      "Business checking",
      "asset",
      { cashFlowClass: "cash" },
      {
        note: "Name it as it appears on your statement. Add a line for each bank account you use.",
      },
    ),
    row("1010", "Business savings", "asset", { cashFlowClass: "cash" }),
    ...(stripe
      ? [
          row(
            "1100",
            "Stripe balance",
            "asset",
            { cashFlowClass: "cash", roleKey: "stripe.balance" },
            {
              note: "Money Stripe holds for you, available and pending.",
            },
          ),
          row("1110", "Stripe payouts in transit", "asset", {
            cashFlowClass: "cash",
            roleKey: "payouts.in-transit",
          }),
        ]
      : []),
    ...(accrual
      ? [row("1200", "Accounts receivable", "asset", { cashFlowClass: "operating" })]
      : []),
    row(
      "1300",
      "Inventory",
      "asset",
      { cashFlowClass: "operating" },
      {
        note: "Goods held for sale. Rastrata does not value inventory: record the count at year end with a journal.",
      },
    ),
    row(
      "1500",
      "Equipment and computers",
      "asset",
      { cashFlowClass: "investing" },
      { note: "At cost." },
    ),
    row("1590", "Accumulated depreciation", "asset", { cashFlowClass: "noncash" }),
    row("2000", "Business credit card", "liability", { cashFlowClass: "operating" }),
    ...(accrual
      ? [row("2100", "Accounts payable", "liability", { cashFlowClass: "operating" })]
      : []),
    row("2200", "Payroll liabilities", "liability", { cashFlowClass: "operating" }),
    row("2300", "Loans payable", "liability", { cashFlowClass: "financing" }),
    ...(stripe
      ? [
          row("2500", "Sales tax payable", "liability", {
            cashFlowClass: "operating",
            roleKey: "tax.sales",
          }),
        ]
      : []),
    row(
      "3000",
      "Owner's investment",
      "equity",
      { cashFlowClass: "financing" },
      { note: "Money you put into the business." },
    ),
    row(
      "3100",
      "Owner's draw",
      "equity",
      { cashFlowClass: "financing" },
      { note: "Money you take out for yourself. Not a business expense." },
    ),
    row("3900", "Opening balance equity", "equity", { cashFlowClass: "financing" }),
    row("4000", "Sales", "income", {
      taxLine: "scheduleC.line1",
      ...(stripe ? { roleKey: "revenue.sales" } : {}),
    }),
    row("4100", "Returns and allowances", "income", {
      taxLine: "scheduleC.line2",
      ...(stripe ? { roleKey: "refunds" } : {}),
    }),
    row("4900", "Other income", "income", { taxLine: "scheduleC.line6" }),
    row("5000", "Cost of goods sold: Purchases", "expense", { taxLine: "scheduleC.line36" }),
    row("5100", "Cost of goods sold: Cost of labor", "expense", { taxLine: "scheduleC.line37" }),
    row("6000", "Advertising and marketing", "expense", { taxLine: "scheduleC.line8" }),
    row("6020", "Commissions and fees", "expense", { taxLine: "scheduleC.line10" }),
    ...(stripe
      ? [
          row("6025", "Stripe fees", "expense", {
            taxLine: "scheduleC.line10",
            roleKey: "stripe.fees",
          }),
          row("6026", "Chargebacks and disputes", "expense", {
            taxLine: "scheduleC.line27b",
            roleKey: "chargebacks",
          }),
        ]
      : []),
    row("6040", "Depreciation", "expense", { taxLine: "scheduleC.line13" }),
    row("6070", "Interest expense", "expense", { taxLine: "scheduleC.line16c" }),
    row("6080", "Legal and professional services", "expense", { taxLine: "scheduleC.line17" }),
    row("6200", "Software and subscriptions", "expense", { taxLine: "scheduleC.line27b" }),
    row("6290", "Other expenses", "expense", { taxLine: "scheduleC.line27b" }),
  ];
  return {
    accounts,
    taxForms: [scheduleC],
    taxYear: 2026,
    notes: [
      "A sole proprietor, or a single-member LLC that has not elected to be taxed as a corporation, reports business income and expenses on Schedule C.",
      "Money you take out is an owner's draw, not an expense. That includes personal income tax and self-employment tax paid from the business account.",
    ],
    disclaimer:
      "Tax lines are named as on the Schedule C (Form 1040) for tax year 2026 (draft form).",
  };
}

/** A chart far larger than a real one, to see how the editor holds up. */
export function bigChart(count = 200): ChartAccount[] {
  const roles: ChartRole[] = ["asset", "liability", "equity", "income", "expense"];
  return Array.from({ length: count }, (_, index) => {
    const role = roles[index % roles.length] as ChartRole;
    const base = { asset: 1000, liability: 2000, equity: 3000, income: 4000, expense: 6000 }[role];
    return {
      key: `big-${index}`,
      code: String(base + Math.floor(index / roles.length) * 10 + 1),
      name: `${role === "expense" ? "Expense" : role === "income" ? "Income stream" : role === "asset" ? "Asset" : role === "liability" ? "Liability" : "Equity"} account ${index + 1}`,
      role,
      tags:
        role === "expense"
          ? { taxLine: "scheduleC.line27b" }
          : role === "income"
            ? { taxLine: "scheduleC.line1" }
            : { cashFlowClass: "operating" as const },
    };
  });
}

export const longNames: ChartAccount[] = [
  row(
    "1000",
    "Business checking account held jointly with the partnership at the regional credit union (operating)",
    "asset",
    { cashFlowClass: "cash" },
  ),
  row(
    "2000",
    "Corporate purchasing card used for travel, subscriptions and other recurring vendor payments",
    "liability",
    { cashFlowClass: "operating" },
  ),
  row(
    "4000",
    "Sales of annual subscriptions, one-off licences, onboarding and implementation services",
    "income",
    { taxLine: "scheduleC.line1" },
  ),
  row(
    "6200",
    "Software, hosting, domain names, developer tools and other subscriptions paid monthly or annually",
    "expense",
    { taxLine: "scheduleC.line27b" },
    {
      note: "A long note that wraps over several lines, so the layout shows what a sentence of guidance does to the height of a row in the table without breaking the columns.",
    },
  ),
];

export const initialChoices: SetupChoices = {
  name: "",
  currency: "USD",
  firstYear: 2026,
  startMonth: 1,
  periodModel: "monthly",
  basis: "cash",
  templateId: "sole-proprietor",
  addOns: [],
};

// ---- The Accounts screen ----
export const lineText = (id: string): string | undefined => {
  const line = scheduleC.lines.find((item) => item.id === id);
  return line ? `Schedule C line ${line.number} · ${line.label}` : undefined;
};

export const account = (
  code: string,
  name: string,
  role: string,
  tags: AccountView["tags"] = {},
  extra: Partial<AccountView> = {},
): AccountView => ({
  id: code.toLowerCase(),
  code,
  name,
  role,
  parentCode: null,
  openedOn: "2026-01-01",
  closedOn: null,
  balance: "0.00",
  tags,
  ...extra,
});

export const accountViews: AccountView[] = [
  account("1000", "Operating account", "asset", { cashFlowClass: "cash" }, { balance: "12480.55" }),
  account("1010", "Tax reserve", "asset", { cashFlowClass: "cash" }, { balance: "3100.00" }),
  account(
    "1100",
    "Stripe balance",
    "asset",
    { cashFlowClass: "cash", roleKey: "stripe.balance" },
    { balance: "845.20" },
  ),
  account("1300", "Inventory", "asset", {}, { balance: "2210.00" }),
  account(
    "1590",
    "Accumulated depreciation",
    "asset",
    { cashFlowClass: "noncash" },
    { balance: "-600.00" },
  ),
  account(
    "2000",
    "Travel card",
    "liability",
    { cashFlowClass: "operating" },
    { balance: "-1250.75" },
  ),
  account(
    "3000",
    "Owner's investment",
    "equity",
    { cashFlowClass: "financing" },
    { balance: "-5000.00" },
  ),
  account("3100", "Owner's draw", "equity", { cashFlowClass: "financing" }, { balance: "1800.00" }),
  account(
    "4000",
    "Sales",
    "income",
    { taxLine: "scheduleC.line1", roleKey: "revenue.sales" },
    { balance: "-21450.00" },
  ),
  account(
    "4100",
    "Returns and allowances",
    "income",
    { taxLine: "scheduleC.line2", roleKey: "refunds" },
    { balance: "310.00" },
  ),
  account(
    "5000",
    "Cost of goods sold: Purchases",
    "expense",
    { taxLine: "scheduleC.line36" },
    { balance: "6120.40" },
  ),
  account(
    "6000",
    "Advertising and marketing",
    "expense",
    { taxLine: "scheduleC.line8" },
    { balance: "1490.00" },
  ),
  account(
    "6025",
    "Stripe fees",
    "expense",
    { taxLine: "scheduleC.line10", roleKey: "stripe.fees" },
    { balance: "702.18" },
  ),
  account("6200", "Software and subscriptions", "expense", {}, { balance: "980.00" }),
  account(
    "6290",
    "Other expenses",
    "expense",
    { taxLine: "scheduleC.line99" },
    { balance: "42.00" },
  ),
  account(
    "6900",
    "Old marketing tool",
    "expense",
    { taxLine: "scheduleC.line8" },
    { balance: "0.00", closedOn: "2026-06-30", parentCode: "6000" },
  ),
];

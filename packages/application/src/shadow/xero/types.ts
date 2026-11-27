/** Xero's account types, and what each means in Rastrata's chart.
 *
 * Xero names a type two ways: the words its screens and exports use ("Current Asset", "Direct Costs",
 * "Non-current Liability") and the codes its integrations use ("CURRENT", "DIRECTCOSTS", "TERMLIAB").
 * Both are read. Each type belongs to one of Xero's five classes, and each class has one role here:
 * assets, liabilities and equity are the same, revenue is income, and every kind of cost is an
 * expense. Xero's own system accounts show up in an export under the name of what they do ("Accounts
 * Receivable", "Sales Tax", "Retained Earnings"); they are read as the class they belong to.
 *
 * The cash-flow class is only a suggestion, for an account that has to be created: it is the class
 * the chart templates give the same kind of account. Nothing here is tax advice. */
import type { CashFlowClass } from "../../account-tags.ts";
import type { OpeningRole } from "../opening.ts";
import { norm } from "./report.ts";

export interface XeroTypeInfo {
  /** How Xero's screens write the type. */
  readonly label: string;
  readonly role: OpeningRole;
  /** The cash-flow class a balance-sheet account of this kind gets in the chart templates. */
  readonly flow?: CashFlowClass;
  /** A bank account in Xero: the accounts a statement is reconciled against. */
  readonly bank: boolean;
  /** Xero creates it and a person cannot delete it. */
  readonly system: boolean;
}

const info = (
  label: string,
  role: OpeningRole,
  extra: { flow?: CashFlowClass; bank?: boolean; system?: boolean } = {},
): XeroTypeInfo => ({
  label,
  role,
  bank: extra.bank ?? false,
  system: extra.system ?? false,
  ...(extra.flow ? { flow: extra.flow } : {}),
});

const BANK = info("Bank", "asset", { flow: "cash", bank: true });
const CURRENT = info("Current Asset", "asset", { flow: "operating" });
const FIXED = info("Fixed Asset", "asset", { flow: "investing" });
const INVENTORY = info("Inventory", "asset", { flow: "operating" });
const NONCURRENT = info("Non-current Asset", "asset", { flow: "investing" });
const PREPAYMENT = info("Prepayment", "asset", { flow: "operating" });
const CURRLIAB = info("Current Liability", "liability", { flow: "operating" });
const LIABILITY = info("Liability", "liability", { flow: "operating" });
const TERMLIAB = info("Non-current Liability", "liability", { flow: "financing" });
const EQUITY = info("Equity", "equity", { flow: "financing" });
const REVENUE = info("Revenue", "income");
const SALES = info("Sales", "income");
const OTHERINCOME = info("Other Income", "income");
const DIRECTCOSTS = info("Direct Costs", "expense");
const EXPENSE = info("Expense", "expense");
const OVERHEADS = info("Overhead", "expense");
const DEPRECIATION = info("Depreciation", "expense");

const ENTRIES: readonly (readonly [readonly string[], XeroTypeInfo])[] = [
  [["bank", "bank account"], BANK],
  // The API calls a card a bank account of the credit card kind; a chart may say so.
  [
    ["credit card", "creditcard"],
    info("Credit Card", "liability", { flow: "operating", bank: true }),
  ],
  [["current asset", "current", "currasset"], CURRENT],
  [["fixed asset", "fixed"], FIXED],
  [["inventory", "inventory asset"], INVENTORY],
  [["non-current asset", "noncurrent asset", "non current asset", "noncurrent"], NONCURRENT],
  [["prepayment", "prepayments"], PREPAYMENT],
  [["current liability", "currliab"], CURRLIAB],
  [["liability"], LIABILITY],
  [
    ["non-current liability", "noncurrent liability", "non current liability", "termliab"],
    TERMLIAB,
  ],
  [["equity"], EQUITY],
  [["revenue"], REVENUE],
  [["sales"], SALES],
  [["other income", "otherincome"], OTHERINCOME],
  [["direct costs", "directcosts"], DIRECTCOSTS],
  [["expense"], EXPENSE],
  [["overhead", "overheads"], OVERHEADS],
  [["depreciation", "depreciatn"], DEPRECIATION],
  // Xero's own accounts, named in an export by what they do.
  [
    ["accounts receivable", "debtors"],
    info("Accounts Receivable", "asset", { flow: "operating", system: true }),
  ],
  [
    ["accounts payable", "creditors"],
    info("Accounts Payable", "liability", { flow: "operating", system: true }),
  ],
  [
    ["sales tax", "gst", "vat"],
    info("Sales Tax", "liability", { flow: "operating", system: true }),
  ],
  [
    ["unpaid expense claims"],
    info("Unpaid Expense Claims", "liability", { flow: "operating", system: true }),
  ],
  [
    ["wages payable", "wages payable - payroll", "wagepayablesliability"],
    info("Wages Payable", "liability", { flow: "operating", system: true }),
  ],
  [
    ["payg liability", "paygliability", "superannuation liability", "superannuationliability"],
    info("Payroll Liability", "liability", { flow: "operating" }),
  ],
  [
    ["wages expense", "wagesexpense", "superannuation expense", "superannuationexpense"],
    info("Payroll Expense", "expense"),
  ],
  [["retained earnings"], info("Retained Earnings", "equity", { flow: "financing", system: true })],
  [
    ["historical adjustment"],
    info("Historical Adjustment", "equity", { flow: "financing", system: true }),
  ],
  [["rounding"], info("Rounding", "expense", { system: true })],
  [["bank revaluations"], info("Bank Revaluations", "expense", { system: true })],
  [["tracking"], info("Tracking", "asset", { flow: "operating", system: true })],
  [["realized currency gains"], info("Realized Currency Gains", "gain", { system: true })],
  [
    ["unrealized currency gains"],
    info("Unrealized Currency Gains", "unrealizedGain", { system: true }),
  ],
];

const BY_KEY: ReadonlyMap<string, XeroTypeInfo> = new Map(
  ENTRIES.flatMap(([keys, value]) => keys.map((key) => [key, value] as const)),
);

/** The type a cell names, or null when it is a type this version does not know. */
export function xeroType(cell: string): XeroTypeInfo | null {
  return BY_KEY.get(norm(cell)) ?? null;
}

/** The types the readers know, for a message that has to say what is accepted. */
export const KNOWN_TYPE_LABELS: readonly string[] = [
  ...new Set(ENTRIES.map(([, value]) => value.label)),
];

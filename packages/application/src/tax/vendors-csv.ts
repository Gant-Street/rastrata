/** CSV for the 1099 vendor totals. Vendor names, payee text and narrations are attacker-controlled, so
 * every text cell is neutralised; money cells are validated decimals. Pure and portable. */
import { amount, render, text } from "../reports/csv.ts";
import { type TaxFileHeader, headerRows } from "./csv.ts";
import type { Payment, PayeeTotal, VendorTotal, VendorTotals } from "./vendors.ts";
import { formatMoney } from "../money.ts";

const REPORTING_WORD = {
  yes: "needs a 1099",
  no: "does not need a 1099",
  undecided: "not decided yet",
} as const;
const REASON_WORD: Readonly<Record<string, string>> = {
  corporation: "incorporated",
  employee: "employee",
  personal: "personal, not for the business",
  merchandise: "merchandise, freight, storage or similar",
  exempt_organization: "tax-exempt organization or government",
  card_or_network: "paid by card or payment app",
  other: "other",
};
const W9_WORD = {
  not_requested: "not requested",
  requested: "requested",
  received: "received",
} as const;
const PAID_BY_WORD = {
  unknown: "not confirmed",
  bank: "bank transfer, check or cash",
  card_or_network: "card or payment app",
} as const;
const CLASSIFICATION_WORD: Readonly<Record<string, string>> = {
  individual: "individual or sole proprietor",
  c_corporation: "C corporation",
  s_corporation: "S corporation",
  partnership: "partnership",
  trust_estate: "trust or estate",
  llc_c: "LLC taxed as a C corporation",
  llc_s: "LLC taxed as an S corporation",
  llc_p: "LLC taxed as a partnership",
  other: "other",
};
const ATTENTION_WORD = {
  undecided: "decide whether it needs a 1099",
  w9_missing: "no W-9 on file",
  method_unconfirmed: "payment method not confirmed (could have been a card or payment app)",
} as const;
const REASON_NOT_COUNTED: Readonly<Record<Payment["reason"], string>> = {
  counted: "",
  card: "paid from a card or other liability account",
  vendor_card_or_network: "vendor is recorded as paid by card or payment app",
  owner: "paid with the owner's own money",
  other_asset: "paid from an account that is not a bank account",
  reclass: "moved between income or expense accounts, not a payment",
  mixed: "paid from both a bank and a card or other account",
};
const PAID_FROM_WORD: Readonly<Record<Payment["paidFrom"], string>> = {
  bank: "bank account",
  card: "card or liability account",
  mixed: "bank and card or other accounts",
  owner: "owner's money",
  other_asset: "other asset account",
  reclass: "income or expense account",
};

const TIN_STATUS_WORD = {
  not_collected: "not collected",
  on_file: "on file",
  verified: "verified",
} as const;

function formatVendorAddress(address: VendorTotal["vendor"]["address"]): string {
  if (!address) return "";
  const cityState = [address.city, address.state].filter(Boolean).join(", ");
  const locality = [cityState, address.postalCode].filter(Boolean).join(" ");
  return [address.line1, address.line2, locality].filter(Boolean).join(", ");
}

const HEAD = [
  "Row",
  "Vendor or payee",
  "Reporting",
  "Reason",
  "W-9",
  "W-9 date",
  "Tax classification on the W-9",
  "Paid by",
  "Payments",
  "Counted toward the threshold",
  "Paid by card or payment app (not counted)",
  "Other payments (not counted)",
  "Threshold",
  "At or over the threshold",
  "Needs attention",
  "Payee text matched",
  "Notes",
];

const EXTRA_HEAD = ["Legal name", "Address", "Email", "TIN status"];

export function vendorsCsv(h: TaxFileHeader, totals: VendorTotals, thresholdCents: bigint): string {
  const threshold = formatMoney(thresholdCents);
  const includeDetails = totals.vendors.some(
    ({ vendor }) =>
      Boolean(vendor.legalName) ||
      Boolean(vendor.address) ||
      Boolean(vendor.email) ||
      (vendor.tinStatus !== undefined && vendor.tinStatus !== "not_collected"),
  );
  const rows: string[][] = [(includeDetails ? [...HEAD, ...EXTRA_HEAD] : HEAD).map(text)];
  for (const entry of totals.vendors as readonly VendorTotal[]) {
    const { vendor } = entry;
    rows.push([
      text("vendor"),
      text(vendor.name),
      text(REPORTING_WORD[vendor.reporting]),
      text(vendor.reason ? (REASON_WORD[vendor.reason] ?? vendor.reason) : ""),
      text(W9_WORD[vendor.w9]),
      text(vendor.w9On ?? ""),
      text(vendor.classification ? (CLASSIFICATION_WORD[vendor.classification] ?? "") : ""),
      text(PAID_BY_WORD[vendor.paidBy]),
      String(entry.payments),
      amount(formatMoney(entry.counted)),
      amount(formatMoney(entry.card)),
      amount(formatMoney(entry.other)),
      amount(threshold),
      text(entry.meetsThreshold ? "yes" : "no"),
      text(entry.attention.map((code) => ATTENTION_WORD[code]).join("; ")),
      text(vendor.payeeKeys.join("; ")),
      text(vendor.notes),
      ...(includeDetails
        ? [
            text(vendor.legalName ?? ""),
            text(formatVendorAddress(vendor.address)),
            text(vendor.email ?? ""),
            text(vendor.tinStatus ? TIN_STATUS_WORD[vendor.tinStatus] : ""),
          ]
        : []),
    ]);
  }
  for (const entry of totals.payees as readonly PayeeTotal[])
    rows.push([
      text(
        entry.ambiguous ? "payee matching more than one vendor" : "payee that is not a vendor yet",
      ),
      text(entry.payee),
      "",
      "",
      "",
      "",
      "",
      "",
      String(entry.payments),
      amount(formatMoney(entry.counted)),
      amount(formatMoney(entry.card)),
      amount(formatMoney(entry.other)),
      amount(threshold),
      text(entry.counted >= thresholdCents ? "yes" : "no"),
      text(""),
      text(""),
      text(""),
      ...(includeDetails ? ["", "", "", ""] : []),
    ]);
  return render([...headerRows(h), ...rows]);
}

export function paymentsCsv(
  h: TaxFileHeader,
  totals: VendorTotals,
  vendorName: (id: string) => string,
): string {
  const rows: string[][] = [
    [
      "Date",
      "Journal ID",
      "Vendor",
      "Payee text",
      "Payee text from",
      "Accounts",
      "Amount",
      "Paid from",
      "Counted",
      "Why not counted",
    ].map(text),
  ];
  for (const payment of totals.payments)
    rows.push([
      text(payment.date),
      text(payment.journalId),
      text(payment.vendorId === null ? "" : vendorName(payment.vendorId)),
      text(payment.payee),
      text(payment.payeeFrom),
      text(payment.accounts.map((account) => `${account.code} ${account.name}`).join("; ")),
      amount(formatMoney(payment.cents)),
      text(PAID_FROM_WORD[payment.paidFrom]),
      text(payment.counts ? "yes" : "no"),
      text(REASON_NOT_COUNTED[payment.reason]),
    ]);
  return render([...headerRows(h), ...rows]);
}

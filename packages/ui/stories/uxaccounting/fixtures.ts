import type { AccountChoice, RegisterCorrection, RegisterEntry } from "../../src";

/** Display values as `journal.list` hands them to the Transactions screen. Fictional: no accounting
 * arithmetic lives here. The long identifiers are what the ledger really names an entry that came with
 * a source, and are the reason the register used to scroll sideways. */
export const accounts: AccountChoice[] = [
  account("1000", "Business checking", "asset"),
  account("1010", "Business savings", "asset"),
  account("1500", "Equipment and computers", "asset"),
  account("2000", "Business credit card", "liability"),
  account("3000", "Owner's investment", "equity"),
  account("3100", "Owner's draw", "equity"),
  account("4000", "Sales", "income"),
  account("6040", "Depreciation", "expense"),
  account("6090", "Office expense", "expense"),
  account("6120", "Rent or lease: Office space", "expense"),
  account("6200", "Software and subscriptions", "expense"),
  account("6290", "Other expenses", "expense"),
];

function account(code: string, name: string, group: string): AccountChoice {
  return { value: code, label: `${code} · ${name}`, path: group, group, code, name };
}

const hash = (seed: string): string =>
  Array.from({ length: 64 }, (_, index) =>
    ((seed.charCodeAt(index % seed.length) * (index + 7)) % 16).toString(16),
  ).join("");

/** A pair the book links: No. 18 was reversed by No. 24. The reversal's narration names the original by
 * the identifier the ledger gave it, as the ledger writes it. */
const ORIGINAL = "0f1c9a0e-5d3b-4c8f-9e2a-1b6d4c7e8f90";
const REVERSAL = "7b2d6e41-93a8-4f10-8c55-2e0a6d9b3c17";
export const corrections: RegisterCorrection[] = [
  {
    kind: "reversal",
    originalJournalId: ORIGINAL,
    correctionJournalId: REVERSAL,
    originalPostingSequence: "18",
    correctionPostingSequence: "24",
  },
];

type Spec = {
  sequence?: number;
  id?: string;
  date: string;
  reference: string;
  description?: string;
  type?: RegisterEntry["type"];
  amount: string;
  status?: "Posted" | "Draft";
  debits: [string, string][];
  credits: [string, string][];
};

function entry(spec: Spec): RegisterEntry {
  const status = spec.status ?? "Posted";
  const id = spec.id ?? `source-${hash(spec.reference + spec.date)}`;
  return {
    id,
    date: spec.date,
    isoDate: spec.date,
    reference: spec.reference,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.sequence !== undefined ? { postingSequence: String(spec.sequence) } : {}),
    ...(spec.type ? { type: spec.type } : {}),
    amount: status === "Draft" ? "—" : spec.amount,
    status,
    lines: [
      ...spec.debits.map(([accountId, debit], index) => ({
        id: `${id}-d${index}`,
        accountId,
        debit,
        credit: null,
      })),
      ...spec.credits.map(([accountId, credit], index) => ({
        id: `${id}-c${index}`,
        accountId,
        debit: null,
        credit,
      })),
    ],
    debitTotal: spec.amount,
    creditTotal: spec.amount,
    history: [
      {
        at: spec.date,
        description:
          status === "Posted"
            ? `Posted at book revision ${spec.sequence ?? 0}`
            : "Saved draft; not posted",
      },
    ],
  };
}

/** A page of the register as the Journal route shows it: newest first, numbered, a draft with none. */
export const transactions: RegisterEntry[] = [
  entry({
    id: "5f1b7c52-6c1e-4f43-9a52-7b9cf8e2d001",
    date: "2026-04-15",
    reference: "EST-TAX-Q1",
    description: "First quarter estimated tax, waiting for the confirmation number",
    amount: "1500.00",
    status: "Draft",
    debits: [["3100", "1500.00"]],
    credits: [["1000", "1500.00"]],
  }),
  entry({
    sequence: 25,
    date: "2026-03-31",
    reference: "DEP-0326",
    description: "March depreciation on the laptop and monitor",
    amount: "58.33",
    debits: [["6040", "58.33"]],
    credits: [["1500", "58.33"]],
  }),
  entry({
    id: REVERSAL,
    sequence: 24,
    date: "2026-03-23",
    reference: `Reversal of ${ORIGINAL}: Entered twice by mistake`,
    amount: "75.00",
    type: "manual",
    debits: [["1000", "75.00"]],
    credits: [["6090", "75.00"]],
  }),
  entry({
    sequence: 23,
    date: "2026-03-20",
    reference: "PERSONAL GROCERY MARKET",
    type: "bank",
    amount: "48.76",
    debits: [["3100", "48.76"]],
    credits: [["1000", "48.76"]],
  }),
  entry({
    sequence: 22,
    date: "2026-03-20",
    reference: "LINEAR ORBIT",
    type: "bank",
    amount: "19.00",
    debits: [["6200", "19.00"]],
    credits: [["1000", "19.00"]],
  }),
  entry({
    id: ORIGINAL,
    sequence: 18,
    date: "2026-03-22",
    reference: "TOOLS-ERR",
    description: "Tools purchase entered twice by mistake",
    type: "manual",
    amount: "75.00",
    debits: [["6090", "75.00"]],
    credits: [["1000", "75.00"]],
  }),
  entry({
    sequence: 21,
    date: "2026-03-17",
    reference: "STRIPE TRANSFER ST-7E69",
    type: "stripe",
    amount: "921.37",
    debits: [["1000", "921.37"]],
    credits: [["4000", "921.37"]],
  }),
  entry({
    sequence: 20,
    date: "2026-03-12",
    reference: "WEWORK 4821 AUSTIN",
    description: "Coworking membership, March",
    amount: "600.00",
    debits: [["6120", "600.00"]],
    credits: [["2000", "600.00"]],
  }),
  entry({
    sequence: 19,
    date: "2026-03-09",
    reference: "STAPLES 00123 AUSTIN TX",
    amount: "318.40",
    debits: [
      ["6090", "118.40"],
      ["1500", "200.00"],
    ],
    credits: [["1000", "318.40"]],
  }),
  entry({
    sequence: 1,
    date: "2026-02-28",
    reference: "OPENING",
    description: "Opening balances",
    type: "opening",
    amount: "17000.00",
    debits: [
      ["1000", "12000.00"],
      ["1010", "6000.00"],
      ["1500", "3500.00"],
    ],
    credits: [
      ["2000", "1250.00"],
      ["3000", "15750.00"],
    ],
  }),
];

/** What the register must cope with: long descriptions, an entry that touches many accounts, a word
 * longer than any column and a reference that repeats the description. */
export const longTransactions: RegisterEntry[] = [
  entry({
    sequence: 1204,
    date: "2026-03-31",
    reference:
      "ANNUAL-LICENSE-RENEWAL-AND-SUPPORT-PLAN-2026-2027-ENTERPRISE-ORGANIZATION-1234567890",
    description:
      "Annual renewal of the design software licenses and the support plan for the whole studio, paid by card on the last day of the quarter after the vendor sent a corrected invoice",
    amount: "12345678.90",
    debits: [
      ["6200", "10000.00"],
      ["6090", "2000.00"],
      ["6290", "345678.90"],
      ["1500", "12000000.00"],
    ],
    credits: [["2000", "12357678.90"]],
  }),
  entry({
    sequence: 1203,
    date: "2026-03-30",
    reference:
      "https://example.invalid/receipts/2026/03/30/7f1c9a0e5d3b4c8f9e2a1b6d4c7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    amount: "9.99",
    debits: [["6200", "9.99"]],
    credits: [["1000", "9.99"]],
  }),
  ...transactions.slice(1, 4),
];

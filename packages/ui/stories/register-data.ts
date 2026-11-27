import type { RegisterEntry } from "../src";
// Fictional, evaluated display values. No accounting arithmetic lives here.
const fixtureRows = [
  {
    id: "JRN-0044",
    date: "23 Sep 2026",
    isoDate: "2026-09-23",
    reference: "Workshop equipment",
    amount: "4,800.00",
    status: "Draft",
    debitAccount: "equipment",
    creditAccount: "payable",
  },
  {
    id: "JRN-0043",
    date: "22 Sep 2026",
    isoDate: "2026-09-22",
    reference: "Office supplies",
    amount: "128.40",
    status: "Posted",
    debitAccount: "office",
    creditAccount: "cash",
  },
  {
    id: "JRN-0042",
    date: "21 Sep 2026",
    isoDate: "2026-09-21",
    reference: "Customer payment",
    amount: "2,450.00",
    status: "Posted",
    debitAccount: "cash",
    creditAccount: "receivable",
  },
  {
    id: "JRN-0041",
    date: "20 Sep 2026",
    isoDate: "2026-09-20",
    reference: "September accrual",
    amount: "320.00",
    status: "Posted",
    debitAccount: "services",
    creditAccount: "payable",
  },
  {
    id: "JRN-0040",
    date: "19 Sep 2026",
    isoDate: "2026-09-19",
    reference: "International operations · Professional services and annual review",
    amount: "16,275.38",
    status: "Draft",
    debitAccount: "international-services",
    creditAccount: "payable",
  },
  {
    id: "JRN-0039",
    date: "18 Sep 2026",
    isoDate: "2026-09-18",
    reference: "Opening balance adjustment",
    amount: "0.00",
    status: "Posted",
    debitAccount: "cash",
    creditAccount: "equity",
  },
];

export const registerEntries: RegisterEntry[] = fixtureRows.map((entry) => ({
  id: entry.id,
  date: entry.date,
  isoDate: entry.isoDate,
  reference: entry.reference,
  amount: entry.amount,
  status: entry.status as RegisterEntry["status"],
  lines: [
    { id: `${entry.id}/1`, accountId: entry.debitAccount, debit: entry.amount, credit: null },
    { id: `${entry.id}/2`, accountId: entry.creditAccount, debit: null, credit: entry.amount },
  ],
  debitTotal: entry.amount,
  creditTotal: entry.amount,
  history: [
    {
      at: entry.date,
      description:
        entry.status === "Posted"
          ? "Created and posted by Alex Morgan"
          : "Draft created by Alex Morgan",
    },
  ],
}));

import type { CsvMapping } from "./csv-mapping.ts";

/** Presets for the CSV exports of common US banks, card issuers and neobanks.
 *
 * A preset is data: how to recognise the export by its header, and the mapping that reads it. To
 * add a bank, add an entry here and a fixture file under test/statements/fixtures with an entry in
 * its manifest; the preset tests pick both up. Nothing else changes.
 *
 * EVERY PRESET HERE IS UNVERIFIED. Rastrata's author had no real statement from any of these
 * banks. Each entry was built from the export's structure as third-party importers and the bank's
 * own help pages describe it, and each fixture is synthetic, shaped like that export. Nothing
 * marks a preset verified except a person comparing it with a real export from the bank and
 * changing `verified` in the same commit as the fixture they checked it with. The product shows
 * the label wherever a preset is named. */

export interface CsvPreset {
  readonly id: string;
  readonly name: string;
  readonly bank: string;
  /** Whether the export describes a deposit account or a credit card. It decides which sign hints
   * the preview offers; the mapping itself says what the signs are. */
  readonly kind: "bank" | "card";
  /** One line a person can compare with the file in front of them. */
  readonly summary: string;
  readonly verified: boolean;
  /** What the preset was built from, so a reviewer knows how far to trust it. */
  readonly basis: string;
  /** Header names (compared ignoring case) that must all be in the file. */
  readonly requires: readonly string[];
  /** Names that raise the match score when present. */
  readonly optional?: readonly string[];
  /** For exports with no header row: the number of columns and a check on the first row. */
  readonly headerless?: {
    readonly columns: number;
    readonly dateColumn: number;
    readonly amountColumn: number;
  };
  /** True when the header is distinctive enough to pick the preset without being asked. A preset
   * whose header any bank might use (Date, Description, Amount) is only used when chosen. */
  readonly autoDetect: boolean;
  /** Headers that, all present besides the required ones, make a preset detectable even though its
   * basic form is not (American Express's longer file names a card member). */
  readonly detectWith?: readonly string[];
  readonly mapping: CsvMapping;
}

const THIRD_PARTY =
  "Column names as third-party importers and the bank's help pages describe them; not checked against a real export";

export const CSV_PRESETS: readonly CsvPreset[] = [
  {
    id: "chase-checking",
    name: "Chase checking, savings and business checking",
    bank: "Chase",
    kind: "bank",
    summary:
      "Details, Posting Date, Description, Amount, Type, Balance, Check or Slip #; dates as MM/DD/YYYY; debits negative; newest first",
    verified: false,
    basis: THIRD_PARTY,
    requires: ["details", "posting date", "description", "amount"],
    optional: ["type", "balance", "check or slip #"],
    autoDetect: true,
    mapping: {
      date: { header: "Posting Date" },
      dateOrder: "mdy",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Description" }],
      reference: { header: "Check or Slip #", optional: true },
      balance: { header: "Balance", optional: true },
    },
  },
  {
    id: "chase-card",
    name: "Chase credit card",
    bank: "Chase",
    kind: "card",
    summary:
      "Transaction Date, Post Date, Description, Category, Type, Amount, Memo (some files start with Card); dates as MM/DD/YYYY; purchases negative, payments positive",
    verified: false,
    basis: THIRD_PARTY,
    requires: ["transaction date", "post date", "description", "category", "type", "amount"],
    optional: ["memo", "card"],
    autoDetect: true,
    mapping: {
      date: { header: "Post Date" },
      dateOrder: "mdy",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Description" }, { header: "Memo", optional: true }],
    },
  },
  {
    id: "rho",
    name: "Rho business account and card",
    bank: "Rho (Webster Bank)",
    kind: "bank",
    summary:
      "Rho lets you choose the columns when you export, so this reads Date, Amount and Status (only settled rows) plus whichever of Description, Memo, Counterparty, Recipient and Sender are present",
    verified: false,
    basis:
      "Rho's help pages (an Export button with a choice of attributes) and its API's transaction fields; Rho does not publish the CSV columns",
    requires: ["date", "amount", "status"],
    optional: ["description", "memo", "recipient", "sender", "counterparty", "type", "department"],
    // Only the table's own words (Sender and Recipient) make this safe to pick unasked.
    autoDetect: false,
    detectWith: ["sender", "recipient"],
    mapping: {
      date: { header: "Date" },
      dateOrder: "auto",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [
        { header: "Description", optional: true },
        { header: "Memo", optional: true },
        { header: "Counterparty", optional: true },
        { header: "Recipient", optional: true },
        { header: "Sender", optional: true },
      ],
      include: {
        column: { header: "Status" },
        values: ["S", "Settled", "Posted", "Completed", "Cleared"],
      },
    },
  },
  {
    id: "mercury",
    name: "Mercury",
    bank: "Mercury",
    kind: "bank",
    summary:
      "Date (UTC), Description, Amount, Status, Source Account, Bank Description, Reference, Note and more; debits negative; only sent (settled) rows",
    verified: false,
    basis: THIRD_PARTY,
    requires: ["date (utc)", "description", "amount", "status"],
    optional: ["bank description", "reference", "source account", "note"],
    autoDetect: true,
    mapping: {
      date: { header: "Date (UTC)" },
      dateOrder: "auto",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Description" }, { header: "Bank Description", optional: true }],
      counterparty: { header: "Description" },
      reference: { header: "Reference", optional: true },
      include: { column: { header: "Status" }, values: ["Sent", "Completed", "Posted", "Settled"] },
    },
  },
  {
    id: "bofa-checking",
    name: "Bank of America checking and savings",
    bank: "Bank of America",
    kind: "bank",
    summary:
      "A short summary block, then Date, Description, Amount, Running Bal.; dates as MM/DD/YYYY; debits negative",
    verified: false,
    basis: THIRD_PARTY,
    requires: ["date", "description", "amount", "running bal."],
    autoDetect: true,
    mapping: {
      date: { header: "Date" },
      dateOrder: "mdy",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Description" }],
      balance: { header: "Running Bal." },
    },
  },
  {
    id: "bofa-card",
    name: "Bank of America credit card",
    bank: "Bank of America",
    kind: "card",
    summary: "Posted Date, Reference Number, Payee, Address, Amount; purchases negative",
    verified: false,
    basis: THIRD_PARTY,
    requires: ["posted date", "reference number", "payee", "amount"],
    optional: ["address"],
    autoDetect: true,
    mapping: {
      date: { header: "Posted Date" },
      dateOrder: "mdy",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Payee" }],
      reference: { header: "Reference Number" },
    },
  },
  {
    id: "wells-fargo",
    name: "Wells Fargo checking and savings",
    bank: "Wells Fargo",
    kind: "bank",
    summary:
      "No header row: date, amount, a * marker, check number, description; dates as MM/DD/YYYY; debits negative",
    verified: false,
    basis:
      "hledger's example rules for this export (references/hledger/examples/csv/banking/wellsfargo-checking.csv.rules); not checked against a real export",
    requires: [],
    headerless: { columns: 5, dateColumn: 1, amountColumn: 2 },
    autoDetect: true,
    mapping: {
      headerRow: 0,
      date: { index: 1 },
      dateOrder: "mdy",
      amount: { kind: "signed", amount: { index: 2 } },
      description: [{ index: 5 }],
      reference: { index: 4 },
    },
  },
  {
    id: "amex-card",
    name: "American Express card",
    bank: "American Express",
    kind: "card",
    summary:
      "Date, Description, Amount (the longer file adds Receipt, Card Member and Account #); dates as MM/DD/YYYY; charges are positive, so the signs are flipped",
    verified: false,
    basis: THIRD_PARTY,
    requires: ["date", "description", "amount"],
    optional: ["card member", "account #", "receipt", "reference"],
    // The three-column file looks like any bank's. Pick this preset when it is an Amex file.
    autoDetect: false,
    detectWith: ["card member"],
    mapping: {
      date: { header: "Date" },
      dateOrder: "mdy",
      amount: { kind: "signed", amount: { header: "Amount" }, invert: true },
      description: [{ header: "Description" }],
      reference: { header: "Reference", optional: true },
    },
  },
  {
    id: "capital-one-card",
    name: "Capital One credit card",
    bank: "Capital One",
    kind: "card",
    summary:
      "Transaction Date, Posted Date, Card No., Description, Category, Debit, Credit; purchases are in Debit and payments in Credit",
    verified: false,
    basis:
      "hledger's example rules for this export (references/hledger/examples/csv/banking/capital-one.csv.rules); not checked against a real export",
    requires: ["transaction date", "posted date", "card no.", "description", "debit", "credit"],
    optional: ["category"],
    autoDetect: true,
    mapping: {
      date: { header: "Posted Date" },
      dateOrder: "auto",
      amount: { kind: "debitCredit", debit: { header: "Debit" }, credit: { header: "Credit" } },
      description: [{ header: "Description" }],
    },
  },
  {
    id: "capital-one-bank",
    name: "Capital One 360 checking and savings",
    bank: "Capital One",
    kind: "bank",
    summary:
      "Account Number, Transaction Date, Transaction Amount, Transaction Type, Transaction Description, Balance; amounts are positive and the type says debit or credit",
    verified: false,
    basis: THIRD_PARTY,
    requires: [
      "account number",
      "transaction date",
      "transaction amount",
      "transaction type",
      "transaction description",
    ],
    optional: ["balance"],
    autoDetect: true,
    mapping: {
      date: { header: "Transaction Date" },
      dateOrder: "mdy",
      amount: {
        kind: "direction",
        amount: { header: "Transaction Amount" },
        direction: { header: "Transaction Type" },
        outValues: ["Debit"],
        inValues: ["Credit"],
      },
      description: [{ header: "Transaction Description" }],
      balance: { header: "Balance", optional: true },
    },
  },
  {
    id: "citi-card",
    name: "Citi credit card",
    bank: "Citi",
    kind: "card",
    summary:
      "Status, Date, Description, Debit, Credit; purchases are in Debit and payments in Credit",
    verified: false,
    basis: THIRD_PARTY,
    requires: ["status", "date", "description", "debit", "credit"],
    autoDetect: true,
    mapping: {
      date: { header: "Date" },
      dateOrder: "mdy",
      amount: { kind: "debitCredit", debit: { header: "Debit" }, credit: { header: "Credit" } },
      description: [{ header: "Description" }],
    },
  },
  {
    id: "us-bank",
    name: "U.S. Bank checking and savings",
    bank: "U.S. Bank",
    kind: "bank",
    summary: "Date, Transaction, Name, Memo, Amount; dates as YYYY-MM-DD; debits negative",
    verified: false,
    basis: THIRD_PARTY,
    requires: ["date", "transaction", "name", "memo", "amount"],
    autoDetect: true,
    mapping: {
      date: { header: "Date" },
      dateOrder: "ymd",
      amount: { kind: "signed", amount: { header: "Amount" } },
      description: [{ header: "Name" }, { header: "Memo" }],
      counterparty: { header: "Name" },
    },
  },
  {
    id: "schwab-bank",
    name: "Charles Schwab Bank checking",
    bank: "Charles Schwab",
    kind: "bank",
    summary:
      "Date, Status, Type, CheckNumber, Description, Withdrawal, Deposit, RunningBalance; amounts like $12.34; only posted rows",
    verified: false,
    basis: THIRD_PARTY,
    requires: ["date", "status", "description", "withdrawal", "deposit", "runningbalance"],
    optional: ["type", "checknumber"],
    autoDetect: true,
    mapping: {
      date: { header: "Date" },
      dateOrder: "mdy",
      amount: {
        kind: "debitCredit",
        debit: { header: "Withdrawal" },
        credit: { header: "Deposit" },
      },
      description: [{ header: "Description" }],
      reference: { header: "CheckNumber", optional: true },
      balance: { header: "RunningBalance" },
      include: { column: { header: "Status" }, values: ["Posted"] },
    },
  },
];

export function presetById(id: string): CsvPreset | undefined {
  return CSV_PRESETS.find((preset) => preset.id === id);
}

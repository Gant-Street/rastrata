/** The shapes the statements components take. They mirror what `import.preview` and the other
 * import operations return, written out here because the UI package depends on nothing but itself.
 * The web page passes the operation results straight through. */

export type Money = string;

export type ColumnRef = { header?: string; index?: number; optional?: boolean };

export type AmountMapping = {
  kind: "signed" | "debitCredit" | "direction";
  amount?: ColumnRef;
  debit?: ColumnRef;
  credit?: ColumnRef;
  direction?: ColumnRef;
  outValues?: readonly string[];
  inValues?: readonly string[];
  invert?: boolean;
};

export type ImportMapping = {
  delimiter?: "," | ";" | "\t" | "|";
  headerRow?: number;
  date: ColumnRef;
  dateOrder?: "auto" | "mdy" | "dmy" | "ymd";
  amount: AmountMapping;
  description: readonly ColumnRef[];
  counterparty?: ColumnRef;
  reference?: ColumnRef;
  balance?: ColumnRef;
  invertBalance?: boolean;
  currency?: string;
  decimal?: "." | ",";
  include?: { column: ColumnRef; values: readonly string[] };
};

/** A layout the service can read by name: one bank's or card issuer's CSV export. */
export type PresetInfo = {
  id: string;
  name: string;
  bank: string;
  kind: "bank" | "card";
  /** The columns the export has, in a line a person can hold up against their file. */
  summary: string;
  /** False until someone has checked the layout against a real export from the bank. */
  verified: boolean;
  basis: string;
};

export type ColumnInfo = { index: number; header: string; samples: readonly string[] };

export type LineStatus = "new" | "duplicate" | "overlap" | "invalid" | "excluded";

export type LinePreview = {
  rawIndex: number;
  row: number;
  postedOn: string;
  amount: Money;
  currency: string;
  description: string;
  counterparty?: string;
  reference?: string;
  runningBalance?: Money;
  providerId?: string;
  status: LineStatus;
  reason?: string;
  flags: readonly string[];
};

export type SampleFilter = "all" | "new" | "duplicate" | "overlap" | "excluded" | "problems";

export type Diagnostic = { severity: "error" | "warning" | "info"; row?: number; message: string };

export type Totals = {
  moneyIn: Money;
  moneyOut: Money;
  net: Money;
  inCount: number;
  outCount: number;
};

export type Counts = {
  rows: number;
  lines: number;
  new: number;
  duplicate: number;
  overlap: number;
  excluded: number;
  invalid: number;
  skipped: number;
};

export type BalanceCheck = {
  accountKey: string;
  asOf: string;
  reported: Money;
  ledger: Money | null;
  waiting: Money | null;
  excluded: Money | null;
  difference: Money | null;
};

export type OfxAccount = {
  key: string;
  label: string;
  type: "bank" | "card";
  accountType: string;
  currency: string;
  count: number;
  from: string | null;
  to: string | null;
};

export type ImportPreviewData = {
  valid: boolean;
  /** Every error is about a single row, so the rest could be imported if the person agrees. */
  skippable: boolean;
  file: { sha256: string; size: number; mediaType: string; name?: string };
  format: "csv" | "ofx" | "unknown";
  account: { id: string; code: string; name: string; role: "asset" | "liability" };
  detection: {
    how: "mapping" | "profile" | "preset" | "detected" | "ofx" | "none";
    preset?: { id: string; name: string; verified: boolean };
    profile?: { id: string; name: string };
    delimiter?: "," | ";" | "\t" | "|";
    headerRow?: number;
    dateOrder?: "mdy" | "dmy" | "ymd";
  };
  mapping?: ImportMapping;
  columns: readonly ColumnInfo[];
  ofx?: {
    version: "1" | "2" | "unknown";
    institution?: string;
    accounts: readonly OfxAccount[];
    selected?: string;
  };
  counts: Counts;
  skipped: {
    notFinal: readonly { value: string; count: number }[];
    noAmount: number;
    zero: number;
    unreadable: number;
  };
  range: { from: string | null; to: string | null };
  totals: Totals;
  newTotals: Totals;
  balances: readonly BalanceCheck[];
  errors: number;
  warnings: number;
  infos: number;
  diagnostics: readonly Diagnostic[];
  hints: readonly string[];
  sample: { count: number; page: number; pageSize: number; lines: readonly LinePreview[] };
};

export type ImportCommitData = {
  batchId: string;
  waiting: number;
  counts: Counts;
  newTotals: Totals;
  balances: readonly BalanceCheck[];
  warnings: number;
  message: string;
};

export type HistoryRow = {
  operationId: string;
  batchId: string;
  on: string;
  file: { sha256: string; name?: string };
  account: { id: string; code: string; name: string };
  counts: Counts;
};

/** What a person reads next to an upload while the file travels. */
export type UploadState = "idle" | "reading" | "uploading" | "error";

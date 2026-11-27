/** Builds the statement fixtures. Run it with `bun build.ts` from this directory; the files it
 * writes are committed, and the tests read them, so nothing depends on running it again.
 *
 * Every file here is SYNTHETIC. No real statement from any bank was available, so each file is
 * shaped like the export it stands for, as that export's structure is documented by third-party
 * importers and by the bank's help pages, filled with invented merchants, invented amounts and
 * masked account numbers. A preset these fixtures exercise is therefore still unverified: a fixture
 * passing proves the code does what the preset says, not that the preset says what the bank does.
 *
 * One ground truth drives every file: a short list of transactions in order, with a running balance
 * worked out here with exact integer cents. Each writer lays that list out the way its bank does
 * (newest first, debit and credit columns, charges positive, a leading summary block...) and the
 * manifest records what a correct parse must find. The tests compare the parser with this ground
 * truth, which was computed without the parser. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatMoney } from "../../../src/money.ts";

interface Tx {
  /** YYYY-MM-DD. */
  date: string;
  /** Signed from the account's view: positive is money in, negative is money out. */
  cents: bigint;
  memo: string;
  /** For the bank-specific type column. */
  kind:
    | "ach_credit"
    | "ach_debit"
    | "card"
    | "check"
    | "fee"
    | "transfer"
    | "zelle"
    | "purchase"
    | "payment"
    | "refund"
    | "interest";
  check?: string;
}

const t = (date: string, amount: string, memo: string, kind: Tx["kind"], check?: string): Tx => ({
  date,
  cents: BigInt(amount.replace(".", "")),
  memo,
  kind,
  ...(check ? { check } : {}),
});

/** A small business checking account across January and February 2026. Two identical lines on the
 * same day (the fuel stop) are deliberate: overlap detection must not collapse them. */
const CHECKING: Tx[] = [
  t("2026-01-02", "2500.00", "STRIPE TRANSFER ST-8KD3P1", "ach_credit"),
  t("2026-01-02", "-44.00", "GITHUB INC SAN FRANCISCO CA", "card"),
  t("2026-01-05", "-1200.00", "CHECK 1041", "check", "1041"),
  t("2026-01-06", "-89.99", "AMAZON WEB SERVICES AWS.AMAZON.CO WA", "card"),
  t("2026-01-09", "850.00", "ZELLE PAYMENT FROM ACME DESIGN LLC", "zelle"),
  t("2026-01-12", "-15.00", "MONTHLY SERVICE FEE", "fee"),
  t("2026-01-15", "-2100.00", "ONLINE TRANSFER TO SAV XXXXXX4321", "transfer"),
  t("2026-01-20", "-62.18", "SHELL OIL 57444 HOUSTON TX", "card"),
  t("2026-01-20", "-62.18", "SHELL OIL 57444 HOUSTON TX", "card"),
  t("2026-01-28", "3100.00", "STRIPE TRANSFER ST-9MQ2L7", "ach_credit"),
  t("2026-02-03", "-44.00", "GITHUB INC SAN FRANCISCO CA", "card"),
  t("2026-02-10", "-318.40", "STAPLES 00123 AUSTIN TX", "card"),
  t("2026-02-14", "1200.00", "ACH CREDIT NORTHWIND LLC INV 2217", "ach_credit"),
  t("2026-02-27", "-750.00", "RENT PAYMENT ACH WEWORK", "ach_debit"),
];
const CHECKING_OPENING = 850000n;

/** A business credit card. Charges are negative in the account's own view, payments positive; the
 * balance after each line is negative while money is owed. */
const CARD: Tx[] = [
  t("2026-01-03", "-49.00", "ADOBE *CREATIVE CLOUD", "purchase"),
  t("2026-01-07", "-129.52", "DELTA AIR LINES ATLANTA GA", "purchase"),
  t("2026-01-11", "-23.45", "UBER *TRIP HELP.UBER.COM", "purchase"),
  t("2026-01-19", "-310.00", "WEWORK 123 SAN FRANCISCO CA", "purchase"),
  t("2026-01-25", "500.00", "AUTOMATIC PAYMENT - THANK YOU", "payment"),
  t("2026-01-29", "23.45", "UBER *TRIP HELP.UBER.COM", "refund"),
  t("2026-02-04", "-49.00", "ADOBE *CREATIVE CLOUD", "purchase"),
  t("2026-02-12", "-1000.00", "APPLE STORE R123 SAN FRANCISCO CA", "purchase"),
  t("2026-02-18", "-18.42", "PURCHASE INTEREST CHARGE", "interest"),
  t("2026-02-25", "700.00", "AUTOMATIC PAYMENT - THANK YOU", "payment"),
];
const CARD_OPENING = 0n;

interface Row extends Tx {
  /** The balance after this line, in the account's own sign. */
  balance: bigint;
}
function withBalances(list: Tx[], opening: bigint): Row[] {
  let balance = opening;
  return list.map((tx) => {
    balance += tx.cents;
    return { ...tx, balance };
  });
}
const checking = withBalances(CHECKING, CHECKING_OPENING);
const card = withBalances(CARD, CARD_OPENING);

const out = (cents: bigint) => formatMoney(cents);
const abs = (cents: bigint) => out(cents < 0n ? -cents : cents);
const mdy = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
const mdy2 = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(2, 4)}`;
const dashedMdy = (date: string) => `${date.slice(5, 7)}-${date.slice(8, 10)}-${date.slice(0, 4)}`;
const compact = (date: string) => date.replaceAll("-", "");
const withCommas = (value: string) => {
  const negative = value.startsWith("-");
  const [whole = "", fraction = ""] = value.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction === "" ? "" : `.${fraction}`}`;
};
const quote = (cell: string) => (/[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
const line = (cells: string[], eol = "\n") => `${cells.map(quote).join(",")}${eol}`;
const allQuoted = (cells: string[], eol = "\n") =>
  `${cells.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")}${eol}`;
const reversed = <T>(list: T[]): T[] => [...list].reverse();

const files = new Map<string, string>();
interface Entry {
  file: string;
  format: "csv" | "ofx";
  /** The preset that must be detected without being asked (absent: none may be). */
  detect?: string;
  /** The preset to ask for (formats that look like any bank's). */
  use?: string;
  /** The story the file was cut from. */
  story: "checking" | "card";
  order: "newest-first" | "oldest-first" | "none";
  /** What the account's own balance is after the newest line (when the file says). */
  closing?: string;
  opening?: string;
  /** Rows a correct parse skips on purpose, by reason. */
  skipped?: Record<string, number>;
  /** Warnings a correct parse is expected to raise, by kind. */
  warns?: string[];
  note?: string;
}
const manifest: Entry[] = [];
const add = (entry: Entry, content: string) => {
  files.set(entry.file, content);
  manifest.push(entry);
};

// ---------------------------------------------------------------------------------------------
// Chase checking, savings and business checking.
{
  const types: Record<Tx["kind"], string> = {
    ach_credit: "ACH_CREDIT",
    ach_debit: "ACH_DEBIT",
    card: "DEBIT_CARD",
    check: "CHECK_PAID",
    fee: "FEE_TRANSACTION",
    transfer: "ACCT_XFER",
    zelle: "QUICKPAY_CREDIT",
    purchase: "DEBIT_CARD",
    payment: "ACH_DEBIT",
    refund: "ACH_CREDIT",
    interest: "MISC_CREDIT",
  };
  let text = "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n";
  for (const row of reversed(checking))
    text += `${row.kind === "check" ? "CHECK" : row.cents < 0n ? "DEBIT" : "CREDIT"},${mdy(row.date)},${quote(row.memo)},${out(row.cents)},${types[row.kind]},${out(row.balance)},${row.check ?? ""},\n`;
  add(
    {
      file: "chase-checking.csv",
      format: "csv",
      detect: "chase-checking",
      story: "checking",
      order: "newest-first",
      opening: out(CHECKING_OPENING),
      closing: out(checking.at(-1)?.balance ?? 0n),
      note: "Rows end with a comma, which makes each one a column wider than the header.",
    },
    text,
  );
}

// ---------------------------------------------------------------------------------------------
// Chase credit card.
{
  const types: Record<string, string> = {
    purchase: "Sale",
    payment: "Payment",
    refund: "Return",
    interest: "Fee",
  };
  let text = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n";
  for (const row of reversed(card)) {
    const posted = row.date;
    const transacted = new Date(`${posted}T00:00:00Z`);
    transacted.setUTCDate(transacted.getUTCDate() - (row.kind === "payment" ? 0 : 1));
    text += `${mdy(transacted.toISOString().slice(0, 10))},${mdy(posted)},${quote(row.memo)},${row.kind === "purchase" ? "Shopping" : row.kind === "payment" ? "" : "Fees & Adjustments"},${types[row.kind]},${out(row.cents)},\n`;
  }
  add(
    {
      file: "chase-card.csv",
      format: "csv",
      detect: "chase-card",
      story: "card",
      order: "newest-first",
      note: "No balance column.",
    },
    text,
  );
}

// ---------------------------------------------------------------------------------------------
// OFX and QFX, written in the two ways banks write them.
const ofxDate = (date: string, offset = "[0:GMT]") => `${compact(date)}120000${offset}`;
function sgml(options: {
  story: Row[];
  opening: bigint;
  kind: "bank" | "card";
  fitid: (row: Row, index: number) => string;
  bankId?: string;
  accountId: string;
  org: string;
  fid: string;
}): string {
  const { story, kind } = options;
  const split = (memo: string) => ({ name: memo.slice(0, 32).trimEnd(), memo });
  let text =
    "OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nSECURITY:NONE\r\nENCODING:USASCII\r\nCHARSET:1252\r\nCOMPRESSION:NONE\r\nOLDFILEUID:NONE\r\nNEWFILEUID:NONE\r\n\r\n";
  text +=
    "<OFX>\r\n<SIGNONMSGSRSV1>\r\n<SONRS>\r\n<STATUS>\r\n<CODE>0\r\n<SEVERITY>INFO\r\n</STATUS>\r\n";
  text += `<DTSERVER>${ofxDate("2026-02-28", "[-5:EST]")}\r\n<LANGUAGE>ENG\r\n<FI>\r\n<ORG>${options.org}\r\n<FID>${options.fid}\r\n</FI>\r\n<INTU.BID>${options.fid}\r\n</SONRS>\r\n</SIGNONMSGSRSV1>\r\n`;
  text +=
    kind === "bank"
      ? "<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n"
      : "<CREDITCARDMSGSRSV1>\r\n<CCSTMTTRNRS>\r\n";
  text += "<TRNUID>1\r\n<STATUS>\r\n<CODE>0\r\n<SEVERITY>INFO\r\n</STATUS>\r\n";
  text +=
    kind === "bank"
      ? "<STMTRS>\r\n<CURDEF>USD\r\n<BANKACCTFROM>\r\n"
      : "<CCSTMTRS>\r\n<CURDEF>USD\r\n<CCACCTFROM>\r\n";
  if (kind === "bank") text += `<BANKID>${options.bankId}\r\n`;
  text += `<ACCTID>${options.accountId}\r\n`;
  if (kind === "bank") text += "<ACCTTYPE>CHECKING\r\n</BANKACCTFROM>\r\n";
  else text += "</CCACCTFROM>\r\n";
  text += `<BANKTRANLIST>\r\n<DTSTART>${ofxDate(story[0]?.date ?? "2026-01-01")}\r\n<DTEND>${ofxDate("2026-02-28")}\r\n`;
  story.forEach((row, index) => {
    const { name, memo } = split(row.memo);
    const trn = row.kind === "check" ? "CHECK" : row.cents < 0n ? "DEBIT" : "CREDIT";
    text += `<STMTTRN>\r\n<TRNTYPE>${trn}\r\n<DTPOSTED>${ofxDate(row.date)}\r\n<TRNAMT>${out(row.cents)}\r\n<FITID>${options.fitid(row, index)}\r\n`;
    if (row.check) text += `<CHECKNUM>${row.check}\r\n`;
    text += `<NAME>${name}\r\n<MEMO>${memo}\r\n</STMTTRN>\r\n`;
  });
  const closing = story.at(-1)?.balance ?? options.opening;
  text += `</BANKTRANLIST>\r\n<LEDGERBAL>\r\n<BALAMT>${out(closing)}\r\n<DTASOF>${ofxDate("2026-02-28")}\r\n</LEDGERBAL>\r\n`;
  text += `<AVAILBAL>\r\n<BALAMT>${out(closing)}\r\n<DTASOF>${ofxDate("2026-02-28")}\r\n</AVAILBAL>\r\n`;
  text +=
    kind === "bank"
      ? "</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n"
      : "</CCSTMTRS>\r\n</CCSTMTTRNRS>\r\n</CREDITCARDMSGSRSV1>\r\n";
  return `${text}</OFX>\r\n`;
}
add(
  {
    file: "chase-checking.qfx",
    format: "ofx",
    story: "checking",
    order: "none",
    closing: out(checking.at(-1)?.balance ?? 0n),
    note: "OFX 1.x SGML as an Intuit QFX: leaf tags are never closed, NAME is cut at 32 characters and MEMO holds the whole description.",
  },
  sgml({
    story: checking,
    opening: CHECKING_OPENING,
    kind: "bank",
    bankId: "123456789",
    accountId: "XXXXXXXXX1234",
    org: "B1",
    fid: "10898",
    fitid: (row, index) => `${compact(row.date)}${String(index + 1).padStart(4, "0")}`,
  }),
);
add(
  {
    file: "chase-card.qfx",
    format: "ofx",
    story: "card",
    order: "none",
    closing: out(card.at(-1)?.balance ?? 0n),
    note: "A credit card statement: CREDITCARDMSGSRSV1, and the ledger balance is negative while money is owed.",
  },
  sgml({
    story: card,
    opening: CARD_OPENING,
    kind: "card",
    accountId: "XXXXXXXXXXXX9876",
    org: "B1",
    fid: "10898",
    fitid: (row, index) => `24${compact(row.date).slice(2)}${index + 1}`,
  }),
);
{
  // OFX 2.x: XML, every tag closed, UTF-8, no header lines.
  let text =
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n<OFX>\n';
  text +=
    "<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20260228120000</DTSERVER><LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>\n";
  text +=
    "<BANKMSGSRSV1><STMTTRNRS><TRNUID>0</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>USD</CURDEF>\n";
  text +=
    "<BANKACCTFROM><BANKID>123456789</BANKID><ACCTID>XXXXXXXXX5678</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>\n<BANKTRANLIST><DTSTART>20260101</DTSTART><DTEND>20260228</DTEND>\n";
  checking.forEach((row, index) => {
    text += `<STMTTRN><TRNTYPE>${row.cents < 0n ? "DEBIT" : "CREDIT"}</TRNTYPE><DTPOSTED>${compact(row.date)}</DTPOSTED><TRNAMT>${out(row.cents)}</TRNAMT><FITID>X${String(index + 1).padStart(6, "0")}</FITID><NAME>${row.memo.replaceAll("&", "&amp;")}</NAME></STMTTRN>\n`;
  });
  text += `</BANKTRANLIST><LEDGERBAL><BALAMT>${out(checking.at(-1)?.balance ?? 0n)}</BALAMT><DTASOF>20260228</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1>\n</OFX>\n`;
  add(
    {
      file: "generic-ofx2.ofx",
      format: "ofx",
      story: "checking",
      order: "none",
      closing: out(checking.at(-1)?.balance ?? 0n),
      note: "OFX 2.x as XML.",
    },
    text,
  );
}

// ---------------------------------------------------------------------------------------------
// Rho: the columns are chosen at export, so this is one plausible choice. Rows that are not
// settled must be skipped, and said so.
{
  const status = [
    "Settled",
    "Settled",
    "Settled",
    "Settled",
    "Settled",
    "Settled",
    "Settled",
    "Settled",
    "Settled",
    "Settled",
    "Settled",
    "Settled",
    "Settled",
    "Settled",
  ];
  let text = "Date,Amount,Sender,Recipient,Type,Status,Memo,User,Department\n";
  checking.forEach((row, index) => {
    const outgoing = row.cents < 0n;
    const [sender, recipient] = outgoing
      ? ["Statements Co Checking", row.memo.split(" ").slice(0, 3).join(" ")]
      : [row.memo.split(" ").slice(0, 3).join(" "), "Statements Co Checking"];
    text += line([
      row.date,
      out(row.cents),
      sender,
      recipient,
      outgoing ? "ACH-US" : "ACH-US",
      status[index] ?? "Settled",
      row.memo,
      "Eric",
      "General",
    ]);
  });
  text += line([
    "2026-02-28",
    "-120.00",
    "Statements Co Checking",
    "Notion Labs",
    "ACH-US",
    "Pending",
    "NOTION LABS",
    "Eric",
    "General",
  ]);
  text += line([
    "2026-02-27",
    "-300.00",
    "Statements Co Checking",
    "Hosting Inc",
    "WIRE-DOM",
    "Canceled",
    "HOSTING INC",
    "Eric",
    "General",
  ]);
  text += line([
    "2026-02-26",
    "-75.00",
    "Statements Co Checking",
    "Design Co",
    "ACH-US",
    "Awaiting Approval",
    "DESIGN CO",
    "Eric",
    "General",
  ]);
  add(
    {
      file: "rho-checking.csv",
      format: "csv",
      detect: "rho",
      story: "checking",
      order: "none",
      skipped: { filtered: 3 },
      note: "Guessed layout: Rho does not publish its CSV columns. Three rows are not settled and must be skipped.",
    },
    text,
  );
}
{
  let text = "Date,Amount,Recipient,Type,Status,Card,User,Memo\n";
  card.forEach((row) => {
    text += line([
      row.date,
      out(row.cents),
      row.memo,
      "card",
      "Settled",
      "Visa ending 4411",
      "Eric",
      "",
    ]);
  });
  text += line([
    "2026-02-27",
    "-61.00",
    "NOTION LABS",
    "card",
    "Pending",
    "Visa ending 4411",
    "Eric",
    "",
  ]);
  add(
    {
      file: "rho-card.csv",
      format: "csv",
      use: "rho",
      story: "card",
      order: "none",
      skipped: { filtered: 1 },
      note: "Guessed layout. A pending card charge must be skipped.",
    },
    text,
  );
}

// ---------------------------------------------------------------------------------------------
// Mercury.
{
  let text = allQuoted([
    "Date (UTC)",
    "Description",
    "Amount",
    "Status",
    "Source Account",
    "Bank Description",
    "Reference",
    "Note",
    "Last Four Digits",
    "Name On Card",
    "Mercury Category",
    "Category",
    "GL Code",
    "Timestamp",
    "Original Currency",
    "Check Number",
    "Tags",
  ]);
  checking.forEach((row) => {
    text += allQuoted([
      dashedMdy(row.date),
      row.memo.split(" ").slice(0, 2).join(" "),
      out(row.cents),
      "Sent",
      "Mercury Checking xx0001",
      row.memo,
      "",
      "",
      "",
      "",
      "Software",
      "",
      "",
      `${dashedMdy(row.date)} 12:00:00`,
      "",
      row.check ?? "",
      "",
    ]);
  });
  text += allQuoted([
    "02-28-2026",
    "Notion Labs",
    "-120.00",
    "Pending",
    "Mercury Checking xx0001",
    "NOTION LABS",
    "",
    "",
    "",
    "",
    "Software",
    "",
    "",
    "02-28-2026 09:00:00",
    "",
    "",
    "",
  ]);
  text += allQuoted([
    "02-27-2026",
    "Hosting Inc",
    "-300.00",
    "Cancelled",
    "Mercury Checking xx0001",
    "HOSTING INC",
    "",
    "",
    "",
    "",
    "Software",
    "",
    "",
    "02-27-2026 09:00:00",
    "",
    "",
    "",
  ]);
  add(
    {
      file: "mercury.csv",
      format: "csv",
      detect: "mercury",
      story: "checking",
      order: "none",
      skipped: { filtered: 2 },
      note: "Two rows are not sent and must be skipped.",
    },
    text,
  );
}

// ---------------------------------------------------------------------------------------------
// Bank of America.
{
  const credits = checking
    .filter((row) => row.cents > 0n)
    .reduce((sum, row) => sum + row.cents, 0n);
  const debits = checking.filter((row) => row.cents < 0n).reduce((sum, row) => sum + row.cents, 0n);
  let text = `Description,,Summary Amt.\nBeginning balance as of 01/01/2026,,"${withCommas(out(CHECKING_OPENING))}"\nTotal credits,,"${withCommas(out(credits))}"\nTotal debits,,"${withCommas(out(debits))}"\nEnding balance as of 02/28/2026,,"${withCommas(out(checking.at(-1)?.balance ?? 0n))}"\n\n`;
  text += "Date,Description,Amount,Running Bal.\n";
  text += `01/01/2026,Beginning balance as of 01/01/2026,,"${withCommas(out(CHECKING_OPENING))}"\n`;
  for (const row of checking)
    text += `${mdy(row.date)},${quote(row.memo)},"${withCommas(out(row.cents))}","${withCommas(out(row.balance))}"\n`;
  add(
    {
      file: "bofa-checking.csv",
      format: "csv",
      detect: "bofa-checking",
      story: "checking",
      order: "oldest-first",
      opening: out(CHECKING_OPENING),
      closing: out(checking.at(-1)?.balance ?? 0n),
      skipped: { noAmount: 1 },
      note: "A summary block comes first, then the header. The beginning balance is a row with no amount.",
    },
    text,
  );
}
{
  let text = "Posted Date,Reference Number,Payee,Address,Amount\n";
  card.forEach((row, index) => {
    text += `${mdy(row.date)},${String(24692166003000000000000n + BigInt(index + 1))},${quote(row.memo)},${quote("SAN FRANCISCO CA")},${out(row.cents)}\n`;
  });
  add(
    {
      file: "bofa-card.csv",
      format: "csv",
      detect: "bofa-card",
      story: "card",
      order: "oldest-first",
    },
    text,
  );
}

// ---------------------------------------------------------------------------------------------
// Wells Fargo: no header row at all.
{
  let text = "";
  for (const row of reversed(checking))
    text += allQuoted([mdy(row.date), out(row.cents), "*", row.check ?? "", row.memo]);
  add(
    {
      file: "wells-fargo.csv",
      format: "csv",
      detect: "wells-fargo",
      story: "checking",
      order: "newest-first",
      note: "No header row; five columns: date, amount, a * marker, check number, description.",
    },
    text,
  );
}

// ---------------------------------------------------------------------------------------------
// American Express. Charges are positive in the file.
{
  let basic = "Date,Description,Amount\n";
  for (const row of reversed(card)) basic += line([mdy(row.date), row.memo, out(-row.cents)]);
  add(
    {
      file: "amex-basic.csv",
      format: "csv",
      use: "amex-card",
      story: "card",
      order: "newest-first",
      note: "Charges are positive and payments negative, the other way round from the book. Looks like any bank's three-column file, so the preset is chosen, not detected.",
    },
    basic,
  );
  let extended = "Date,Receipt,Description,Card Member,Account #,Amount\n";
  for (const row of reversed(card))
    extended += line([mdy(row.date), "", row.memo, "ERIC EXAMPLE", "-12345", out(-row.cents)]);
  add(
    {
      file: "amex-extended.csv",
      format: "csv",
      detect: "amex-card",
      story: "card",
      order: "newest-first",
      note: "The longer file names a card member, which is distinctive enough to detect.",
    },
    extended,
  );
}

// ---------------------------------------------------------------------------------------------
// Capital One.
{
  let text = "Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n";
  for (const row of reversed(card))
    text += line([
      row.date,
      row.date,
      "1234",
      row.memo,
      row.kind === "purchase" ? "Merchandise" : "Payment/Credit",
      row.cents < 0n ? abs(row.cents) : "",
      row.cents > 0n ? abs(row.cents) : "",
    ]);
  add(
    {
      file: "capital-one-card.csv",
      format: "csv",
      detect: "capital-one-card",
      story: "card",
      order: "newest-first",
      note: "Purchases in Debit, payments and returns in Credit; ISO dates.",
    },
    text,
  );
  let bank =
    "Account Number,Transaction Date,Transaction Amount,Transaction Type,Transaction Description,Balance\n";
  for (const row of reversed(checking))
    bank += line([
      "1234567890",
      mdy2(row.date),
      abs(row.cents),
      row.cents < 0n ? "Debit" : "Credit",
      row.memo,
      out(row.balance),
    ]);
  add(
    {
      file: "capital-one-bank.csv",
      format: "csv",
      detect: "capital-one-bank",
      story: "checking",
      order: "newest-first",
      opening: out(CHECKING_OPENING),
      closing: out(checking.at(-1)?.balance ?? 0n),
      note: "Positive amounts with a Debit or Credit type, two-digit years.",
    },
    bank,
  );
}

// ---------------------------------------------------------------------------------------------
// Citi.
{
  let text = "Status,Date,Description,Debit,Credit\n";
  for (const row of reversed(card))
    text += line([
      "Cleared",
      mdy(row.date),
      row.memo,
      row.cents < 0n ? abs(row.cents) : "",
      row.cents > 0n ? abs(row.cents) : "",
    ]);
  add(
    {
      file: "citi-card.csv",
      format: "csv",
      detect: "citi-card",
      story: "card",
      order: "newest-first",
    },
    text,
  );
  let negative = "Status,Date,Description,Debit,Credit\n";
  for (const row of reversed(card))
    negative += line([
      "Cleared",
      mdy(row.date),
      row.memo,
      row.cents < 0n ? abs(row.cents) : "",
      row.cents > 0n ? out(-row.cents) : "",
    ]);
  add(
    {
      file: "citi-card-negative-credit.csv",
      format: "csv",
      detect: "citi-card",
      story: "card",
      order: "newest-first",
      warns: ["debit_credit_sign"],
      note: "Credits written as negative numbers in the Credit column: the sign is ignored, and said so.",
    },
    negative,
  );
}

// ---------------------------------------------------------------------------------------------
// U.S. Bank and Schwab.
{
  let text = allQuoted(["Date", "Transaction", "Name", "Memo", "Amount"]);
  for (const row of reversed(checking))
    text += allQuoted([
      row.date,
      row.cents < 0n ? "DEBIT" : "CREDIT",
      row.memo.split(" ").slice(0, 3).join(" "),
      row.memo,
      out(row.cents),
    ]);
  add(
    {
      file: "us-bank.csv",
      format: "csv",
      detect: "us-bank",
      story: "checking",
      order: "newest-first",
    },
    text,
  );
  let schwab = allQuoted([
    "Date",
    "Status",
    "Type",
    "CheckNumber",
    "Description",
    "Withdrawal",
    "Deposit",
    "RunningBalance",
  ]);
  for (const row of reversed(checking))
    schwab += allQuoted([
      mdy(row.date),
      "Posted",
      row.check ? "CHECK" : "ACH",
      row.check ?? "",
      row.memo,
      row.cents < 0n ? `$${withCommas(abs(row.cents))}` : "",
      row.cents > 0n ? `$${withCommas(abs(row.cents))}` : "",
      `$${withCommas(out(row.balance))}`,
    ]);
  schwab += allQuoted([
    "02/28/2026",
    "Pending",
    "ACH",
    "",
    "NOTION LABS",
    "$120.00",
    "",
    "$12,000.00",
  ]);
  add(
    {
      file: "schwab-bank.csv",
      format: "csv",
      detect: "schwab-bank",
      story: "checking",
      order: "newest-first",
      opening: out(CHECKING_OPENING),
      closing: out(checking.at(-1)?.balance ?? 0n),
      skipped: { filtered: 1 },
      note: "Dollar signs and thousands separators in the amounts; one pending row to skip.",
    },
    schwab,
  );
}

// ---------------------------------------------------------------------------------------------
const here = import.meta.dir;
mkdirSync(here, { recursive: true });
for (const [name, content] of files) {
  mkdirSync(dirname(join(here, name)), { recursive: true });
  writeFileSync(join(here, name), content);
}
const truth = (list: Row[]) =>
  list.map((row) => ({
    date: row.date,
    amount: out(row.cents),
    memo: row.memo,
    kind: row.kind,
    ...(row.check ? { check: row.check } : {}),
  }));
const sum = (list: Row[], positive: boolean) =>
  out(
    list.filter((row) => row.cents > 0n === positive).reduce((total, row) => total + row.cents, 0n),
  );
const summary = (list: Row[]) => ({
  count: list.length,
  moneyIn: sum(list, true),
  moneyOut: sum(list, false),
  net: out(list.reduce((total, row) => total + row.cents, 0n)),
  from: list[0]?.date,
  to: list.at(-1)?.date,
});
writeFileSync(
  join(here, "manifest.json"),
  `${JSON.stringify(
    {
      note: "Ground truth for the fixtures, computed by build.ts with exact integer cents, never by the parser. Every file is synthetic.",
      stories: {
        checking: {
          opening: out(CHECKING_OPENING),
          ...summary(checking),
          transactions: truth(checking),
        },
        card: { opening: out(CARD_OPENING), ...summary(card), transactions: truth(card) },
      },
      files: manifest,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${files.size} fixtures and manifest.json`);

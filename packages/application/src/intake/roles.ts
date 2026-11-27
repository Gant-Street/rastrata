import { normalizeHeader } from "../statements/csv-mapping.ts";
import type { Confidence, Role, RoleReason } from "./sets.ts";

/** What a delimited file is for, guessed from its column names and the title lines above them.
 * Everything here is a guess from vocabulary, so the answer carries the reasons it was reached
 * for, as codes, and a confidence. It reads names only, never amounts, and returns no text from
 * the file. */

export type Concept =
  | "date"
  | "dueDate"
  | "description"
  | "amount"
  | "debit"
  | "credit"
  | "balance"
  | "account"
  | "accountName"
  | "type"
  | "invoice"
  | "customer"
  | "status"
  | "payout"
  | "balanceTransaction"
  | "reportingCategory"
  | "gross"
  | "fee"
  | "net"
  | "source"
  | "name"
  | "code"
  | "merchant"
  | "card";

const has = (key: string, pattern: RegExp): boolean => pattern.test(key);

/** The concepts one header cell names. A cell can name more than one ("Debit Balance" is not a
 * special case; it names a debit and a balance). */
export function conceptsOf(cell: string): Concept[] {
  // Xero marks the columns it requires with an asterisk.
  const key = normalizeHeader(cell)
    .replace(/[_*-]+/g, " ")
    .trim();
  if (key === "") return [];
  const found: Concept[] = [];
  const add = (concept: Concept, pattern: RegExp) => {
    if (has(key, pattern)) found.push(concept);
  };
  // A due date is not the date of a transaction.
  add("dueDate", /\bdue\b/);
  if (!found.includes("dueDate"))
    add(
      "date",
      /\b(date|posted|posting|booked|booking|timestamp|created|effective|available on)\b/,
    );
  add("description", /\b(description|memo|narrative|details?|payee|particulars|notes?)\b/);
  add("amount", /^(amount|transaction amount|amt|value|net amount)$|\bamount\b/);
  add("debit", /\b(debit|debits|withdrawal|withdrawals|money out|paid out|dr)\b/);
  add("credit", /\b(credit|credits|deposit|deposits|money in|paid in|cr)\b/);
  add("balance", /\b(balance|bal)\b/);
  add("accountName", /\baccount( name)?$|^accounts?$/);
  add("account", /\baccount\b|^acct\b|^code$|\baccount (code|number|no|id)\b/);
  add("type", /\b(type|class)\b/);
  add("invoice", /\binvoice\b|^inv\b/);
  add("customer", /\b(customer|client|bill to|contact)\b/);
  add("status", /\b(status|state)\b/);
  add("payout", /\bpayout\b/);
  add("balanceTransaction", /\bbalance transaction\b/);
  add("reportingCategory", /\breporting category\b/);
  add("gross", /\bgross\b/);
  add("fee", /^fees?$|\bfee\b/);
  add("net", /^net$/);
  add("source", /\bsource\b/);
  add("name", /^(name|account name|payee|vendor|supplier)$/);
  add("code", /^(code|account code|account number|account no|acct code|account #)$/);
  add("merchant", /\bmerchant\b/);
  add("card", /\bcard( no| number)?\b|\bcardholder\b/);
  return found;
}

export interface Signals {
  readonly concepts: ReadonlySet<Concept>;
  /** Number of header cells that named any concept at all. */
  readonly recognised: number;
}

export function signalsOf(headers: readonly string[]): Signals {
  const concepts = new Set<Concept>();
  let recognised = 0;
  for (const header of headers) {
    const found = conceptsOf(header);
    if (found.length > 0) recognised++;
    for (const concept of found) concepts.add(concept);
  }
  return { concepts, recognised };
}

export interface RoleGuess {
  readonly role: Role;
  readonly confidence: Confidence;
  readonly reasons: readonly RoleReason[];
}

export interface TableEvidence {
  readonly headers: readonly string[];
  /** The title lines above the header, lower case, bounded. */
  readonly titles: readonly string[];
  /** Some data rows carry a date in a date column. */
  readonly datedRows: boolean;
  /** The file has a row that reads as a total. */
  readonly totalRow: boolean;
  /** The number of distinct values in the account column, when there is one. */
  readonly distinctAccounts: number | null;
  /** How strongly the file reads as a card's: a score from its column names, its title, the
   * words of its lines and the way its amounts are signed. Three or more is a card. */
  readonly cardScore: number;
  /** For a file with no header row: whether its rows have a date, an amount and some words. */
  readonly shape?: "dated_amounts";
}

const titled = (titles: readonly string[], pattern: RegExp): boolean =>
  titles.some((line) => pattern.test(line));

export function guessRole(evidence: TableEvidence): RoleGuess {
  const { concepts } = signalsOf(evidence.headers);
  const { titles } = evidence;
  const reasons: RoleReason[] = [];
  const result = (role: Role, confidence: Confidence): RoleGuess => ({
    role,
    confidence,
    reasons,
  });

  // A payout report names Stripe's own columns.
  const payoutColumns =
    (concepts.has("balanceTransaction") ? 1 : 0) +
    (concepts.has("payout") ? 1 : 0) +
    (concepts.has("reportingCategory") ? 1 : 0) +
    (concepts.has("gross") && concepts.has("fee") && concepts.has("net") ? 1 : 0);
  if (payoutColumns >= 2) {
    reasons.push("header_payout_columns");
    return result("payout_report", "high");
  }

  // Invoices: an invoice number and who owes it, or the title says so.
  if (
    (concepts.has("invoice") && (concepts.has("dueDate") || concepts.has("customer"))) ||
    (titled(titles, /\binvoices?\b/) && !concepts.has("debit") && !concepts.has("credit"))
  ) {
    reasons.push("header_invoice_columns");
    if (titled(titles, /\binvoices?\b/)) reasons.push("title_invoices");
    return result("invoices", concepts.has("invoice") ? "high" : "medium");
  }

  const paired = concepts.has("debit") && concepts.has("credit");
  const somethingToSum = paired || concepts.has("amount") || concepts.has("balance");
  const named =
    concepts.has("account") ||
    concepts.has("accountName") ||
    concepts.has("code") ||
    (concepts.has("name") && !concepts.has("date"));

  // Title lines are the strongest evidence for the reports an accounting system exports.
  if (titled(titles, /\btrial balance\b/)) {
    reasons.push("title_trial_balance");
    if (named && somethingToSum) reasons.push("header_account_and_debit_credit");
    return result("trial_balance", "high");
  }
  if (titled(titles, /\bchart of accounts\b|\baccount list\b|\blist of accounts\b/)) {
    reasons.push("title_chart_of_accounts");
    return result("chart_of_accounts", "high");
  }
  if (
    titled(titles, /\bgeneral ledger\b|\baccount transactions\b|\btransaction detail\b|\bjournal\b/)
  ) {
    reasons.push("title_general_ledger");
    return result("general_ledger", "high");
  }

  // A trial balance has an account and what it holds, and no dates down the rows.
  if (
    named &&
    (paired || concepts.has("balance")) &&
    !evidence.datedRows &&
    !concepts.has("date")
  ) {
    reasons.push("header_account_and_debit_credit", "no_dates_in_rows");
    if (evidence.totalRow) reasons.push("total_row");
    return result("trial_balance", evidence.totalRow || paired ? "medium" : "low");
  }
  // A chart names each account and what kind it is, and holds no dates or movements.
  if (named && concepts.has("type") && !evidence.datedRows && !paired && !concepts.has("amount")) {
    reasons.push("header_account_and_type", "no_dates_in_rows");
    return result("chart_of_accounts", "medium");
  }

  // A ledger has a date, an account for each row that differs from row to row, and a movement.
  // A bank's own statement may carry an account number column, but it holds one value.
  if (
    concepts.has("date") &&
    named &&
    (paired || concepts.has("amount")) &&
    (evidence.distinctAccounts ?? 0) >= 3
  ) {
    reasons.push("header_ledger_columns", "many_accounts");
    return result("general_ledger", "medium");
  }
  if (named && evidence.distinctAccounts === 1) reasons.push("single_account");

  // A statement has dates, a movement and some words about it.
  if (
    concepts.has("date") &&
    (concepts.has("amount") || paired) &&
    (concepts.has("description") ||
      concepts.has("name") ||
      concepts.has("merchant") ||
      concepts.has("type"))
  ) {
    reasons.push("header_statement_columns");
    if (concepts.has("balance")) reasons.push("header_running_balance");
    if (titled(titles, /\bstatement\b|\bactivity\b|\btransactions?\b/))
      reasons.push("title_statement");
    // A statement does not say whether it is a card's. The score is the evidence that it is; below
    // three the guess is a bank's, and the plan knows the account's own kind either way.
    const card = evidence.cardScore >= 3;
    if (card) reasons.push("card_words");
    return result(
      card ? "card_statement" : "bank_statement",
      evidence.cardScore >= 1 && !card ? "low" : "medium",
    );
  }
  if (concepts.has("date") && (concepts.has("amount") || paired)) {
    reasons.push("header_statement_columns");
    if (evidence.cardScore >= 3) {
      reasons.push("card_words");
      return result("card_statement", "low");
    }
    return result("bank_statement", "low");
  }
  // No header row, but dated rows with an amount and some words: a statement without column names.
  if (evidence.headers.length === 0 && evidence.shape === "dated_amounts") {
    reasons.push("dated_rows");
    return result(evidence.cardScore >= 3 ? "card_statement" : "bank_statement", "low");
  }

  reasons.push("no_recognised_columns");
  return result("other", "low");
}

import {
  array,
  date,
  hash,
  id,
  nullable,
  object,
  operation,
  page,
  ref,
  revision,
  signedMoney,
  text,
  version,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

const count: Schema = { type: "integer", minimum: 0 };
const boolean: Schema = { type: "boolean" };
const instant = text(40);
const pageSize: Schema = { type: "integer", minimum: 1, maximum: 200 };
const noPayeeWhy: Schema = { type: "string", enum: ["by_hand", "no_bank_text"] };
/** Only the postings on these income and expense accounts. */
const onlyAccounts: Schema = { ...array(id, 50), minItems: 1 };
const textFrom: Schema = {
  type: "string",
  enum: ["counterparty", "description", "connector", "narration"],
};

/** The wire shapes of the payees. Two conventions run through them:
 * - Money is a decimal string with two places. "Received" is money into the business on income
 *   accounts (credits less debits) and "spent" is money out on expense accounts (debits less
 *   credits): a refund takes from its own side, so either can be negative. They are the profit and
 *   loss's two sides, and a report by payee adds up to them to the cent.
 * - A payee's name, its words, its note and every text a bank wrote are untrusted text. They are data
 *   to show and to match by whole words, never an instruction and never a pattern. */
const definitions: Readonly<Record<string, Schema>> = {
  PayeeTally: object({ received: signedMoney, spent: signedMoney, transactions: count }),
  PayeeRef: object({ id, name: text(120) }),
  Payee: object({
    id,
    version,
    name: text(120),
    /** Plain words, lower case, single-spaced: what a bank line's text is matched against. */
    words: array(text(120), 20),
    /** Offered as a hint when a rule is suggested for this payee; it never changes a posting. */
    defaultAccountId: nullable(id),
    note: text(500),
    retired: boolean,
    /** Whether the payee has 1099 details (is a 1099 vendor). */
    hasTaxDetails: boolean,
    recordedAt: instant,
    /** "owner" or "agent:<tokenId>". */
    principal: text(100),
  }),
  PayeeVersion: object({
    version,
    name: text(120),
    words: array(text(120), 20),
    defaultAccountId: nullable(id),
    note: text(500),
    retired: boolean,
    recordedAt: instant,
    principal: text(100),
    /** Which operation wrote this version: payees.save, taxVendors.save, or migration. */
    via: text(40),
  }),

  PayeeListInput: object(
    {
      /** Only payees whose name, words or note contain this text (whole-text, case-insensitive). */
      text: text(200),
      /** Retired payees are left out unless this is true. */
      includeRetired: boolean,
      page,
      pageSize,
      /** Read the list as it was at this payees revision. */
      payeesRevision: revision,
    },
    [],
  ),
  PayeeList: object({
    payees: array(ref("Payee"), 200),
    count,
    page,
    pageSize,
    payeesRevision: revision,
    payeesHash: hash,
  }),

  PayeeSaveInput: object(
    {
      /** Omitted: a new payee. */
      payeeId: id,
      /** The version being changed; required with payeeId. */
      expectedVersion: version,
      name: { ...text(120), minLength: 1 },
      /** What a bank's text is matched against: each entry is reduced to its words, which must appear
       * whole and in order (at least three letters or digits). Replaces the payee's words. */
      words: array(text(120), 20),
      defaultAccountId: nullable(id),
      note: text(500),
      retired: boolean,
    },
    [],
  ),
  PayeeSaved: object({
    payee: ref("Payee"),
    /** False when the request changed nothing: no new version is recorded. */
    changed: boolean,
    payeesRevision: revision,
    payeesHash: hash,
  }),

  PayeeDirection: { type: "string", enum: ["both", "spent", "received"] },
  PayeeMonth: object({
    month: text(7),
    from: date,
    to: date,
    profitLossIncome: signedMoney,
    profitLossExpenses: signedMoney,
  }),
  PayeeTotalsRow: object(
    {
      payeeId: id,
      name: text(120),
      retired: boolean,
      received: signedMoney,
      spent: signedMoney,
      /** Received less spent. */
      net: signedMoney,
      transactions: count,
      firstOn: date,
      lastOn: date,
      /** With byMonth: this payee's figures for each month of the range, in the order of `months`. */
      months: array(ref("PayeeTally"), 36),
    },
    ["payeeId", "name", "retired", "received", "spent", "net", "transactions", "firstOn", "lastOn"],
  ),
  PayeeUnnamedRow: object(
    {
      /** The group's key: its text with every run of digits made one. Pass it to payees.get. */
      key: text(300),
      /** The text of the group's largest transaction, as a bank wrote it, made safe and short. */
      text: text(300),
      /** Words to start from when naming this payee: always in the text, whole and in order. A
       * suggestion; empty when the text names nobody. */
      suggestedWords: text(120),
      received: signedMoney,
      spent: signedMoney,
      net: signedMoney,
      transactions: count,
      firstOn: date,
      lastOn: date,
      months: array(ref("PayeeTally"), 36),
    },
    [
      "key",
      "text",
      "suggestedWords",
      "received",
      "spent",
      "net",
      "transactions",
      "firstOn",
      "lastOn",
    ],
  ),
  PayeeAmbiguousRow: object(
    {
      key: text(300),
      text: text(300),
      /** The payees whose words match this text equally well, so it is given to none of them. */
      payees: array(ref("PayeeRef"), 20),
      received: signedMoney,
      spent: signedMoney,
      net: signedMoney,
      transactions: count,
      firstOn: date,
      lastOn: date,
      months: array(ref("PayeeTally"), 36),
    },
    ["key", "text", "payees", "received", "spent", "net", "transactions", "firstOn", "lastOn"],
  ),
  /** What a bounded list left out, added up. */
  PayeeRest: object({
    groups: count,
    received: signedMoney,
    spent: signedMoney,
    transactions: count,
  }),
  PayeeNoPayee: object({
    /** Entries typed in by hand whose own words name no payee. */
    byHand: ref("PayeeTally"),
    /** Bank lines that came with no counterparty and no description. */
    noBankText: ref("PayeeTally"),
  }),
  /** What each place of the report adds up to over the whole range (not only the rows a page shows),
   * so a screen can lay the proof out: received and spent in the payees, in the texts not named yet, in
   * the texts two payees match equally and in the entries with no payee. */
  PayeePlaces: object({
    payees: ref("PayeeTally"),
    unnamed: ref("PayeeTally"),
    ambiguous: ref("PayeeTally"),
    noPayee: ref("PayeeTally"),
  }),
  PayeeTie: object({
    /** The profit and loss of the same range and revision: total income and total expenses. */
    profitLossIncome: signedMoney,
    profitLossExpenses: signedMoney,
    /** What the rows, the unnamed, the ambiguous and the no-payee lines add up to. */
    income: signedMoney,
    expenses: signedMoney,
    /** The four places those sums are made of, whatever side the report lists. */
    places: ref("PayeePlaces"),
    /** Always true in a reply: a report that did not tie fails with report_does_not_tie instead. */
    matches: boolean,
  }),
  PayeeTotalsInput: object(
    {
      asOf: date,
      /** Omitted: the first day of the fiscal year that contains asOf. */
      from: date,
      /** Read the book as it was at this revision. */
      revision,
      /** Read the payees as they were at this payees revision. */
      payeesRevision: revision,
      /** Only the postings on these income and expense accounts (for the largest payees of one
       * account, say): the report then adds up to the profit and loss of those accounts. Omitted:
       * every income and expense account. */
      accountIds: onlyAccounts,
      /** Which side to list and order by: spent, received, or both (the default). The tie-out always
       * covers both. */
      direction: ref("PayeeDirection"),
      /** Also give every figure by calendar month (up to 36 months). */
      byMonth: boolean,
      /** Which page of the payees' rows to give. */
      page,
      pageSize,
    },
    ["asOf"],
  ),
  PayeeTotals: object(
    {
      from: date,
      to: date,
      currency: text(3),
      basis: ref("ReportBasis"),
      bookRevision: revision,
      payeesRevision: revision,
      payeesHash: hash,
      /** The population of the profit and loss of the same range. */
      ledgerPopulationHash: hash,
      /** This report's own: the ledger population, the payees and the texts behind the journals. */
      populationHash: hash,
      direction: ref("PayeeDirection"),
      /** The accounts the report was limited to, when it was. */
      accountIds: array(id, 50),
      months: array(ref("PayeeMonth"), 36),
      /** Named payees with activity in the range, largest first, one page. */
      rows: array(ref("PayeeTotalsRow"), 200),
      rowCount: count,
      page,
      pageSize,
      /** Bank texts that match no payee, grouped (digits count as one), largest first; at most 100. */
      unnamed: array(ref("PayeeUnnamedRow"), 100),
      unnamedCount: count,
      unnamedRest: ref("PayeeRest"),
      /** Texts that match two payees equally, so they are given to neither; at most 50. */
      ambiguous: array(ref("PayeeAmbiguousRow"), 50),
      ambiguousCount: count,
      ambiguousRest: ref("PayeeRest"),
      noPayee: ref("PayeeNoPayee"),
      /** Everything in the range, the places above added up. */
      totals: ref("PayeeTally"),
      tieOut: ref("PayeeTie"),
      /** False when the Inbox could not be read: every entry was then matched on its own narration. */
      inboxRead: boolean,
      warnings: array(ref("ReportWarning"), 12),
    },
    [
      "from",
      "to",
      "currency",
      "basis",
      "bookRevision",
      "payeesRevision",
      "payeesHash",
      "ledgerPopulationHash",
      "populationHash",
      "direction",
      "rows",
      "rowCount",
      "page",
      "pageSize",
      "unnamed",
      "unnamedCount",
      "unnamedRest",
      "ambiguous",
      "ambiguousCount",
      "ambiguousRest",
      "noPayee",
      "totals",
      "tieOut",
      "inboxRead",
      "warnings",
    ],
  ),

  PayeeSubject: object(
    {
      kind: { type: "string", enum: ["payee", "unnamed", "ambiguous", "no_payee"] },
      payeeId: id,
      key: text(300),
      text: text(300),
      why: noPayeeWhy,
      payees: array(ref("PayeeRef"), 20),
    },
    ["kind"],
  ),
  PayeeTransaction: object({
    date,
    journalId: id,
    narration: text(300),
    /** The text that was matched, as a bank wrote it, made safe and short. */
    text: text(300),
    textFrom: nullable(textFrom),
    received: signedMoney,
    spent: signedMoney,
    /** The income and expense accounts it is on. */
    accounts: text(400),
    /** Whose it is, when it is a payee's. */
    payee: nullable(ref("PayeeRef")),
    /** The words that matched. */
    key: nullable(text(120)),
    /** The journal this one reverses, when it is a reversal: its payee is that one's. */
    reverses: nullable(id),
  }),
  PayeeGetInput: object(
    {
      /** Exactly one of these four says what to read. */
      payeeId: id,
      /** A group of unnamed texts, by the key payees.totals gave it. */
      unnamed: text(300),
      ambiguous: text(300),
      noPayee: noPayeeWhy,
      asOf: date,
      from: date,
      revision,
      payeesRevision: revision,
      accountIds: onlyAccounts,
      page,
      pageSize,
    },
    ["asOf"],
  ),
  PayeeDetail: object(
    {
      subject: ref("PayeeSubject"),
      /** The payee, when the subject is one. */
      payee: nullable(ref("Payee")),
      /** Every version of the payee with who and when, oldest first. */
      history: array(ref("PayeeVersion"), 200),
      transactions: array(ref("PayeeTransaction"), 200),
      count,
      page,
      pageSize,
      totals: ref("PayeeTally"),
      from: date,
      to: date,
      currency: text(3),
      basis: ref("ReportBasis"),
      bookRevision: revision,
      payeesRevision: revision,
      ledgerPopulationHash: hash,
      populationHash: hash,
      accountIds: array(id, 50),
      inboxRead: boolean,
      warnings: array(ref("ReportWarning"), 12),
    },
    [
      "subject",
      "payee",
      "history",
      "transactions",
      "count",
      "page",
      "pageSize",
      "totals",
      "from",
      "to",
      "currency",
      "basis",
      "bookRevision",
      "payeesRevision",
      "ledgerPopulationHash",
      "populationHash",
      "inboxRead",
      "warnings",
    ],
  ),

  PayeeTestInput: object(
    {
      /** The words as they would be saved: each entry is reduced to its words. */
      words: { ...array(text(120), 20), minItems: 1 },
      /** The payee being changed: its present words are replaced by these. Omitted for a new payee. */
      payeeId: id,
      asOf: date,
      from: date,
      revision,
      payeesRevision: revision,
      accountIds: onlyAccounts,
    },
    ["words", "asOf"],
  ),
  PayeeTestTaken: object({ payee: ref("PayeeRef"), tally: ref("PayeeTally") }),
  PayeeTestTie: object({
    received: signedMoney,
    spent: signedMoney,
    transactions: count,
    payees: array(ref("PayeeRef"), 20),
  }),
  PayeeTest: object({
    /** The keys that would be saved. */
    keys: array(text(120), 20),
    /** What payees.save would refuse these words for, in words a person can act on. */
    problems: array(ref("ReportWarning"), 20),
    /** The transactions that would be this payee's once saved. */
    matches: ref("PayeeTally"),
    /** Of those, the ones already this payee's. */
    stays: ref("PayeeTally"),
    fromUnnamed: ref("PayeeTally"),
    fromAmbiguous: ref("PayeeTally"),
    /** Of those, entries with no bank text to tell them apart by. */
    fromNowhere: ref("PayeeTally"),
    /** Of those, the ones that belong to another payee now and would move. */
    taken: array(ref("PayeeTestTaken"), 50),
    /** Transactions this payee has now and would not have (its words changed). */
    lost: ref("PayeeTally"),
    /** Transactions the words match as well as another payee's: given to neither. */
    tied: ref("PayeeTestTie"),
    /** Transactions that contain the words but stay with another payee whose words are longer. */
    beaten: array(ref("PayeeTestTaken"), 50),
    /** A few of the transactions that would be this payee's, the largest first. */
    sample: array(ref("PayeeTransaction"), 5),
    from: date,
    to: date,
    bookRevision: revision,
    payeesRevision: revision,
    ledgerPopulationHash: hash,
    inboxRead: boolean,
  }),

  PayeeExportInput: object(
    {
      asOf: date,
      from: date,
      revision,
      payeesRevision: revision,
      /** `summary`: each payee, each group of unnamed and ambiguous texts and the no-payee lines, with
       * the tie-out to the profit and loss. `transactions`: every transaction in the range with its
       * payee. Omitted: summary. */
      file: { type: "string", enum: ["summary", "transactions"] },
      /** With `transactions`: only this payee's. */
      payeeId: id,
      accountIds: onlyAccounts,
    },
    ["asOf"],
  ),
  PayeeExport: object({
    filename: text(200),
    mediaType: text(80),
    bookRevision: revision,
    populationHash: hash,
    content: { type: "string", maxLength: 16_000_000 },
  }),
};

export const payeesSchema: SliceSchema = {
  name: "payees",
  definitions,
  operations: [
    operation(
      "payees.list",
      "List the payees: the one list of people and businesses the book pays or is paid by, each with one name, the words that identify it in a bank's text, an optional default account, a note and whether it has 1099 details (a 1099 vendor is a payee with 1099 details; the ids are the same). Retired payees are left out unless asked for. payeesRevision and payeesHash name the list that was read.",
      "read",
      "PayeeListInput",
      false,
      "PayeeList",
    ),
    operation(
      "payees.get",
      "Read what a row of the report by payee is made of, one page of its transactions for a range: a payee (with every version of it, who made it and when), or a group of unnamed texts, a group of ambiguous texts, or the entries with no payee (name which with exactly one of payeeId, unnamed, ambiguous or noPayee). Each transaction says its date, the journal, the text that was matched and its money. Use payees.totals first to learn the keys of the groups.",
      "read",
      "PayeeGetInput",
      false,
      "PayeeDetail",
    ),
    operation(
      "payees.save",
      "Create a payee or record a new version of one: its name, the words that identify it in a bank's text, an optional default account, a note, and whether it is retired. Words are matched whole and in order, never as a pattern (each is reduced to its words, at least three letters or digits, and belongs to one payee); try them first with payees.test. A change names the version it changes (expectedVersion); a stale one is refused with payee_version_conflict. Naming a payee changes which row of the report its transactions are in and posts nothing. Needs configure permission. A payee that is a 1099 vendor keeps its name and words in step with the vendor.",
      "configure",
      "PayeeSaveInput",
      true,
      "PayeeSaved",
    ),
    operation(
      "payees.test",
      "Try some words before saving them: how many transactions in a range they would give a payee, the money in them, how many are unnamed or another payee's now (and would move), which would be tied with another payee or stay with one whose words are longer, and which of the payee's present transactions it would lose. Also says what payees.save would refuse the words for. Reads only.",
      "read",
      "PayeeTestInput",
      false,
      "PayeeTest",
    ),
    operation(
      "payees.totals",
      "The report 'Money by payee' for a range at a pinned book revision: each payee with money received, money spent, net and transactions, largest first; below it the unnamed bank texts (grouped, digits count as one), the texts that match two payees equally, and the entries with no payee, as rows of their own. The places add up to the profit and loss of the same range to the cent (tieOut), or the call fails with report_does_not_tie; nothing is hidden. Only income and expense accounts are in it: transfers, loan principal, assets bought and owner draws are not money spent here. Read the Inbox's text, so lines still waiting for review are not in it (they are not in the books).",
      "read",
      "PayeeTotalsInput",
      false,
      "PayeeTotals",
    ),
    operation(
      "payees.export",
      "Render the report by payee as CSV text (summary: each payee, the unnamed and ambiguous groups, the no-payee lines and the tie-out; or transactions: every transaction with its payee, optionally one payee's), headed by its book revision, range, basis and population hash. Text cells that a spreadsheet could run as a formula are neutralised with a leading quote. For a person or an accountant; read payees.totals to analyse figures.",
      "read",
      "PayeeExportInput",
      false,
      "PayeeExport",
    ),
  ],
};

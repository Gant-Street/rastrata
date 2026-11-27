/** CSV for the report by payee. Payee names, bank texts and narrations are attacker-controlled, so every
 * text cell goes through the reports lane's neutraliser (a cell that begins `=`, `+`, `-` or `@` is
 * prefixed with a quote); a money cell is validated to be a plain decimal and written as is. Every
 * file says which book revision, range and population it was made from. Pure and portable. */
import { formatMoney } from "../money.ts";
import { amount, render, text } from "../reports/csv.ts";
import type { JournalEffect, PayeeTotals, Tally } from "./totals.ts";

export interface PayeeFileHeader {
  readonly title: string;
  readonly book: string;
  readonly currency: string;
  readonly basis: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly bookRevision: string;
  readonly payeesRevision: string;
  readonly populationHash: string;
  readonly ledgerPopulationHash: string;
  readonly compilerVersion: string;
  /** The accounts the file was limited to, as "code name" entries; empty for every account. */
  readonly accounts?: readonly string[];
}

function headerRows(h: PayeeFileHeader): string[][] {
  return [
    [text("Report"), text(h.title)],
    [text("Book"), text(h.book)],
    [text("Currency"), text(h.currency)],
    [text("Basis"), text(h.basis)],
    [text("Period start"), text(h.periodStart)],
    [text("Period end"), text(h.periodEnd)],
    [text("Book revision"), text(h.bookRevision)],
    [text("Payees revision"), text(h.payeesRevision)],
    [text("Population hash"), text(h.populationHash)],
    [text("Ledger population hash"), text(h.ledgerPopulationHash)],
    [text("Compiler version"), text(h.compilerVersion)],
    ...(h.accounts && h.accounts.length > 0
      ? [[text("Accounts"), text(h.accounts.join("; "))]]
      : []),
    [],
  ];
}

const money = (cents: bigint): string => amount(formatMoney(cents));

/** What a payee is called on a row, and the words that find it. */
export interface PayeeNames {
  readonly name: (payeeId: string) => string;
  readonly words: (payeeId: string) => readonly string[];
}

const tallyCells = (tally: Tally, firstOn: string, lastOn: string): string[] => [
  money(tally.received),
  money(tally.spent),
  money(tally.received - tally.spent),
  String(tally.transactions),
  text(firstOn),
  text(lastOn),
];

/** The report: each payee, each group of unnamed and ambiguous texts, the lines with no payee, the
 * total and the profit and loss it adds up to. */
export function summaryCsv(
  h: PayeeFileHeader,
  totals: PayeeTotals,
  names: PayeeNames,
  suggest: (text: string) => string,
): string {
  const rows: string[][] = [
    [
      "Row",
      "Payee or text",
      "Words",
      "Received",
      "Spent",
      "Net",
      "Transactions",
      "First",
      "Last",
    ].map(text),
  ];
  for (const row of totals.rows)
    rows.push([
      text("payee"),
      text(row.name),
      text(names.words(row.payeeId).join("; ")),
      ...tallyCells(row, row.firstOn, row.lastOn),
    ]);
  for (const group of totals.unnamed)
    rows.push([
      text("unnamed"),
      text(group.text),
      text(suggest(group.text)),
      ...tallyCells(group, group.firstOn, group.lastOn),
    ]);
  for (const group of totals.ambiguous)
    rows.push([
      text("ambiguous"),
      text(group.text),
      text(group.payeeIds.map((id) => names.name(id)).join("; ")),
      ...tallyCells(group, group.firstOn, group.lastOn),
    ]);
  const none = (label: string, tally: Tally) =>
    rows.push([text("no payee"), text(label), "", ...tallyCells(tally, "", "")]);
  none("Entered by hand", totals.noPayee.byHand);
  none("No bank text", totals.noPayee.noBankText);
  rows.push([]);
  rows.push([
    text("total"),
    text("Everything in the range"),
    "",
    ...tallyCells(totals.totals, "", ""),
  ]);
  rows.push([
    text("profit and loss"),
    text("Total income and total expenses of the same range"),
    "",
    money(totals.profitLoss.income),
    money(totals.profitLoss.expenses),
    money(totals.profitLoss.income - totals.profitLoss.expenses),
    "",
    "",
    "",
  ]);
  return render([...headerRows(h), ...rows]);
}

/** Every transaction in the range, with whose it is. */
export function transactionsCsv(
  h: PayeeFileHeader,
  journals: readonly JournalEffect[],
  names: PayeeNames,
): string {
  const rows: string[][] = [
    [
      "Date",
      "Journal ID",
      "Row",
      "Payee",
      "Text matched",
      "Words matched",
      "Accounts",
      "Received",
      "Spent",
      "Narration",
    ].map(text),
  ];
  for (const effect of journals) {
    const outcome = effect.outcome;
    const row =
      outcome.kind === "payee" ? "payee" : outcome.kind === "none" ? "no payee" : outcome.kind;
    rows.push([
      text(effect.date),
      text(effect.journalId),
      text(row),
      text(
        outcome.kind === "payee"
          ? names.name(outcome.payeeId)
          : outcome.kind === "ambiguous"
            ? outcome.payeeIds.map((id) => names.name(id)).join("; ")
            : outcome.kind === "none"
              ? outcome.why === "by_hand"
                ? "Entered by hand"
                : "No bank text"
              : "",
      ),
      text(effect.text),
      text(outcome.kind === "payee" ? outcome.key : ""),
      text(effect.accounts.map((account) => `${account.code} ${account.name}`).join("; ")),
      money(effect.received),
      money(effect.spent),
      text(effect.narration),
    ]);
  }
  return render([...headerRows(h), ...rows]);
}

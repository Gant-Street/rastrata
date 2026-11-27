import { centsToMoney, formatMoney, moneyToCents } from "../format";
import { entryWords } from "./entry-words";

/** The new-entry form's rules, with no UI in them: what a person types in an amount box and what the
 * service takes, the totals the bar shows, and what stands in the way of saving or posting. Pure
 * functions of their arguments, so they behave the same on the page, in a story and in a test. */

export type EntryLine = { accountId: string; debit: string; credit: string };

export const blankEntryLine = (): EntryLine => ({ accountId: "", debit: "", credit: "" });

/** The ids of the controls a problem points at, so a list of problems can move focus to the right one. */
export const entryIds = {
  date: "entry-date",
  description: "entry-description",
  sourceId: "entry-source-id",
  sourceDescription: "entry-source-description",
  account: (index: number) => `entry-line-${index + 1}-account`,
  debit: (index: number) => `entry-line-${index + 1}-debit`,
  credit: (index: number) => `entry-line-${index + 1}-credit`,
};

const AMOUNT_TEXT = /^(\d{1,16})(?:\.(\d{0,2}))?$/;

/** An amount as a person types it, made into the form the service takes ("100" is "100.00", "1,000.5" is
 * "1000.50", ".5" is "0.50", "$12" is "12.00"). An empty box stays empty. `undefined` when the text is not
 * an amount, so the box keeps what was typed and says what is wrong. */
export function normalizeEntryAmount(text: string): string | undefined {
  const cleaned = text
    .trim()
    .replace(/^[$€£]\s*/, "")
    .replace(/[,\s]/g, "");
  if (cleaned === "") return "";
  const dotted = cleaned.startsWith(".") ? `0${cleaned}` : cleaned;
  const match = AMOUNT_TEXT.exec(dotted);
  if (!match) return undefined;
  const whole = (match[1] as string).replace(/^0+(?=\d)/, "");
  const cents = (match[2] ?? "").padEnd(2, "0");
  return `${whole}.${cents}`;
}

/** What is wrong with the text of one amount box, in words, or `undefined` when it is empty or an amount. A
 * box is checked when it is left, not while it is being typed. */
export function entryAmountProblem(text: string): string | undefined {
  const typed = text.trim();
  if (typed === "" || normalizeEntryAmount(typed) !== undefined) return undefined;
  const w = entryWords.amount;
  if (typed.startsWith("-") || typed.startsWith("(")) return w.negative;
  if (/^[$€£]?\s*[\d,]*\.\d{3,}$/.test(typed)) return w.tooPrecise;
  return w.notAnAmount;
}

/** The lines as the service takes them: every amount in its two-decimal form. A line the person has not
 * finished (an amount that is not one) is left as typed, and the service says what it refuses. */
export function normalizedEntryLines(lines: readonly EntryLine[]): EntryLine[] {
  return lines.map((line) => ({
    accountId: line.accountId,
    debit: normalizeEntryAmount(line.debit) ?? line.debit,
    credit: normalizeEntryAmount(line.credit) ?? line.credit,
  }));
}

const isZero = (amount: string): boolean => amount !== "" && moneyToCents(amount) === 0n;
const hasAmount = (amount: string): boolean => amount !== "" && !isZero(amount);

export interface EntryTotals {
  readonly debit: string;
  readonly credit: string;
  /** The gap between them, never negative. */
  readonly difference: string;
  readonly balanced: boolean;
}

/** The sums the bar shows, or `null` while any amount is not one (the bar says so instead of guessing). */
export function entryTotals(lines: readonly EntryLine[]): EntryTotals | null {
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    const left = normalizeEntryAmount(line.debit);
    const right = normalizeEntryAmount(line.credit);
    if (left === undefined || right === undefined) return null;
    if (left !== "") debit += moneyToCents(left);
    if (right !== "") credit += moneyToCents(right);
  }
  return {
    debit: centsToMoney(debit),
    credit: centsToMoney(credit),
    difference: centsToMoney(debit > credit ? debit - credit : credit - debit),
    balanced: debit === credit,
  };
}

export interface EntryProblem {
  /** The id of the control to take the person to. */
  readonly id: string;
  /** The whole sentence, for the list of problems ("Line 2: Choose an account."). */
  readonly message: string;
  /** The same said beside its own control, where the line is already named ("Choose an account."). */
  readonly short: string;
}

/** What stands in the way of saving or posting an entry, in the order the form reads. A draft may be
 * unfinished (no description, an unbalanced entry), so it needs only a date, an account on every line and
 * amounts that are amounts; posting needs all of it. */
export function entryProblems(input: {
  date: string;
  description: string;
  lines: readonly EntryLine[];
  /** The source event the entry came from, when it names one: a source that names no facts is refused. */
  source?: { readonly id: string; readonly description: string } | undefined;
  /** `draft` is what Save draft asks for; `post` is what Post asks for. */
  purpose: "draft" | "post";
}): EntryProblem[] {
  const w = entryWords.problems;
  const found: EntryProblem[] = [];
  const whole = (id: string, message: string) => found.push({ id, message, short: message });
  const onLine = (id: string, index: number, short: string) =>
    found.push({ id, message: w.line(index + 1, short), short });
  if (input.date.trim() === "") whole(entryIds.date, w.dateRequired);
  if (input.purpose === "post" && input.description.trim() === "")
    whole(entryIds.description, w.descriptionRequired);
  if (input.source && input.source.id.trim() !== "" && input.source.description.trim() === "")
    whole(entryIds.sourceDescription, w.sourceDescriptionRequired);

  let withAmount = 0;
  input.lines.forEach((line, index) => {
    if (line.accountId === "") onLine(entryIds.account(index), index, w.chooseAccount);
    for (const side of ["debit", "credit"] as const) {
      const problem = entryAmountProblem(line[side]);
      if (problem) onLine(entryIds[side](index), index, problem);
    }
    const left = normalizeEntryAmount(line.debit);
    const right = normalizeEntryAmount(line.credit);
    // An amount that is not one has been said already.
    if (left === undefined || right === undefined) return;
    if (hasAmount(left) && hasAmount(right)) onLine(entryIds.debit(index), index, w.oneSide);
    else if (hasAmount(left) || hasAmount(right)) withAmount += 1;
    else if (input.purpose === "post") {
      if (left === "" && right === "") onLine(entryIds.debit(index), index, w.enterAmount);
      else
        onLine(
          left !== "" ? entryIds.debit(index) : entryIds.credit(index),
          index,
          entryWords.amount.zero,
        );
    }
  });

  if (input.purpose === "post" && found.length === 0) {
    if (withAmount < 2) whole(entryIds.account(0), w.needTwo);
    const totals = entryTotals(input.lines);
    if (totals && !totals.balanced)
      whole(entryIds.debit(0), w.outOfBalance(formatMoney(totals.difference)));
  }
  return found;
}

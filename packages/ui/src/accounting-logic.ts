import type { AccountChoice, RegisterCorrection, RegisterEntry } from "./accounting-types";
import { listAccountLabel } from "./entries/display";

/** How an entry stands to the reversal it is part of: it was reversed by another entry, or it is the
 * reversal of one. `number` is the other entry's number when the application gave it. */
export type CorrectionNote = {
  readonly kind: "reversedBy" | "reverses";
  readonly journalId: string;
  readonly number: string | undefined;
};

export function correctionNote(
  entryId: string,
  corrections: readonly RegisterCorrection[] | undefined,
): CorrectionNote | undefined {
  for (const link of corrections ?? []) {
    if (link.originalJournalId === entryId)
      return {
        kind: "reversedBy",
        journalId: link.correctionJournalId,
        number: link.correctionPostingSequence,
      };
    if (link.correctionJournalId === entryId)
      return {
        kind: "reverses",
        journalId: link.originalJournalId,
        number: link.originalPostingSequence,
      };
  }
  return undefined;
}

/** What a reversal says in words. The ledger writes its narration with the identifier of the entry it
 * reverses ("Reversal of ed68952c-9494-...: Entered twice"); a person reads that entry by its number
 * ("Reversal of No. 28: Entered twice"). Any other narration is returned as it is. */
export function plainNarration(
  narration: string,
  entryId: string,
  corrections: readonly RegisterCorrection[] | undefined,
  entryNumber: (sequence: string) => string,
): string {
  const link = (corrections ?? []).find((item) => item.correctionJournalId === entryId);
  if (!link?.originalPostingSequence || !narration.includes(link.originalJournalId))
    return narration;
  return narration.replace(link.originalJournalId, entryNumber(link.originalPostingSequence));
}

/** The accounts an entry touches, read as money moving: the accounts it credits are where the money
 * came from and the accounts it debits are where it went. "Business checking → Software" is a payment
 * for software; "Sales → Business checking" is a customer paying. Names only: an account's code is for
 * the chart, the pickers and the reports. */
export type AccountFlow = {
  /** The accounts credited, in the order the entry names them, each once. */
  from: readonly string[];
  /** The accounts debited, in the order the entry names them, each once. */
  to: readonly string[];
  /** Accounts the entry names with no amount yet (a draft being filled in). */
  open: readonly string[];
};

const hasAmount = (value: string | null): boolean => value !== null && value !== "";

/** The name an account is listed by: its own name when it has one (with its number before it when the
 * owner asked for numbers in lists), otherwise what it is called in a picker (a code and a name),
 * otherwise its identifier. */
export function accountName(accounts: readonly AccountChoice[], id: string): string {
  const choice = accounts.find((account) => account.value === id);
  if (choice?.name) return listAccountLabel(choice.name, choice.code);
  return choice?.label ?? id;
}

export function accountFlow(
  entry: Pick<RegisterEntry, "lines">,
  accounts: readonly AccountChoice[],
): AccountFlow {
  const from: string[] = [];
  const to: string[] = [];
  const open: string[] = [];
  const add = (list: string[], id: string) => {
    const name = accountName(accounts, id);
    if (!list.includes(name)) list.push(name);
  };
  for (const line of entry.lines) {
    if (hasAmount(line.credit) && !hasAmount(line.debit)) add(from, line.accountId);
    else if (hasAmount(line.debit) && !hasAmount(line.credit)) add(to, line.accountId);
    else if (hasAmount(line.debit) && hasAmount(line.credit)) {
      add(from, line.accountId);
      add(to, line.accountId);
    } else add(open, line.accountId);
  }
  return { from, to, open };
}

/** A side of an entry as a sentence fragment: up to `limit` names, then how many more there are. */
export function sideText(
  names: readonly string[],
  limit: number,
  more: (count: number) => string,
): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")}, ${more(names.length - limit)}`;
}

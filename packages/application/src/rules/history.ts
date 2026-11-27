import type { BankLine, DecidedItem } from "../ingest-types.ts";
import { formatMoney, parseMoney } from "../money.ts";
import { lineText, type TrainingExample } from "./classifier.ts";
import { clip } from "./text.ts";

/** Reading posted journals as past bank lines, for training the classifier and for testing a rule
 * against history. A journal that moved money through an asset account (the bank side) and booked
 * the other side to a category account is a line somebody decided; this recovers that decision.
 *
 * What it will not guess: a journal with no asset side (an accrual), one that only moves money
 * between assets (a transfer, which the transfer matcher owns), and one whose asset side nets to
 * zero are not decisions about a category and are left out. */

export interface PostedJournal {
  readonly id: string;
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly narration: string;
  /** The description of the source event it was posted from, when it had one (a bank memo). */
  readonly sourceDescription?: string;
  /** Signed cents, debit positive. */
  readonly postings: readonly {
    readonly accountId: string;
    readonly role: string;
    readonly cents: bigint;
  }[];
}

export interface PostedLine {
  readonly journalId: string;
  readonly date: string;
  readonly text: string;
  /** Net movement of the asset side: positive is money in. */
  readonly cents: bigint;
  readonly bankAccountId: string;
  /** The non-asset account with the largest amount: the category the line was booked to. */
  readonly categoryId: string;
  /** True when more than one account took the other side. */
  readonly split: boolean;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const abs = (cents: bigint): bigint => (cents < 0n ? -cents : cents);

const EARNING_ROLES = ["income", "expense", "gain", "unrealizedGain", "equity"];

export function postedLine(journal: PostedJournal): PostedLine | null {
  let assets = journal.postings.filter((posting) => posting.role === "asset");
  let others = journal.postings.filter((posting) => posting.role !== "asset");
  if (assets.length === 0) {
    // A credit card is a liability: with no asset side, a liability stands in for the bank.
    const liabilities = journal.postings.filter((posting) => posting.role === "liability");
    const rest = journal.postings.filter((posting) => posting.role !== "liability");
    if (liabilities.length === 0 || !rest.some((posting) => EARNING_ROLES.includes(posting.role)))
      return null;
    assets = liabilities;
    others = rest;
  }
  if (others.length === 0) return null;
  let net = 0n;
  for (const posting of assets) net += posting.cents;
  if (net === 0n) return null;
  const biggest = (list: typeof assets) =>
    [...list].sort(
      (a, b) =>
        (abs(b.cents) > abs(a.cents) ? 1 : abs(b.cents) < abs(a.cents) ? -1 : 0) ||
        compare(a.accountId, b.accountId),
    )[0];
  const bank = biggest(assets);
  const category = biggest(others);
  if (!bank || !category) return null;
  const text = clip((journal.sourceDescription?.trim() || journal.narration).trim(), 1000);
  if (text === "") return null;
  return {
    journalId: journal.id,
    date: journal.date,
    text,
    cents: net,
    bankAccountId: bank.accountId,
    categoryId: category.accountId,
    split: new Set(others.map((posting) => posting.accountId)).size > 1,
  };
}

export function exampleFromLine(line: PostedLine): TrainingExample {
  return {
    key: `journal:${line.journalId}`,
    accountId: line.categoryId,
    text: line.text,
    direction: line.cents > 0n ? "in" : "out",
    on: line.date,
    source: line.bankAccountId,
  };
}

/** A past line shaped like a bank line, so the same rules run over it as over the inbox. */
export function asBankLine(line: PostedLine, currency: string): BankLine {
  return {
    kind: "bankLine",
    provider: "ledger",
    accountKey: line.bankAccountId,
    rawIndex: 0,
    postedOn: line.date,
    amount: formatMoney(line.cents),
    currency,
    description: line.text,
  };
}

/** What a person (or an accepted suggestion) decided for a line in the Inbox, as something to learn
 * from: the memo as the Inbox shows it, which side the money moved, and the account that took the
 * other side. Null for anything that is not a bank line with a category: lines matched to an
 * existing entry, exclusions and structured events carry no category decision. */
export function exampleFromDecision(decided: DecidedItem): TrainingExample | null {
  const { item } = decided;
  if (item.line.kind !== "bankLine") return null;
  let cents: bigint;
  try {
    cents = parseMoney(item.line.amount);
  } catch {
    return null;
  }
  if (cents === 0n) return null;
  const others = decided.legs.filter((leg) => leg.accountId !== item.ledgerAccountId);
  const sized = others.flatMap((leg) => {
    try {
      return [{ accountId: leg.accountId, size: abs(parseMoney(leg.amount)) }];
    } catch {
      return [];
    }
  });
  const category = sized.sort(
    (a, b) => (b.size > a.size ? 1 : b.size < a.size ? -1 : 0) || compare(a.accountId, b.accountId),
  )[0];
  if (!category) return null;
  return {
    key: `decision:${item.id}`,
    accountId: category.accountId,
    text: lineText(item.line),
    direction: cents > 0n ? "in" : "out",
    on: item.line.postedOn,
    ...(item.ledgerAccountId !== null ? { source: item.ledgerAccountId } : {}),
  };
}

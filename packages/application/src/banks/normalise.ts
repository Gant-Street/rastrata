import type { BankAccountOffer, BankTransaction } from "../agent/bank-wire.ts";
import { isPlausibleEpoch, utcDate } from "../bankfeed/time.ts";
import { sha256Hex } from "../ingest/hash.ts";
import { hasControlCharacters } from "../ingest/text.ts";
import type { BankLine } from "../ingest-types.ts";
import { formatMoney } from "../money.ts";

/** The transactions a bank connection brought, as lines for the ingestion pipeline. Pure: no clock, no network, no book.
 *
 * What it will not do, and why (the same rules as the SimpleFIN lane, whose answer is written differently but whose figures are held to the same standard):
 *  - **Import a pending or voided transaction.** A pending one can change its amount, post under another identifier or vanish; importing it would book money the bank
 *    never moved, or twice. It is counted and left for when the bank has posted it.
 *  - **Round.** Stripe reports an amount as a whole number of the smallest unit of its currency, so there is nothing to round; a value that is not a whole number is
 *    unreadable, and is *held* (reported with its identifier and the reason, never imported, never skipped silently, and it never stops the rest).
 *  - **Convert.** A line carries its own currency. If it is not the book's, the pipeline flags it `foreign_currency` and a person has to decide.
 *  - **Obey text.** A description is stored as received (the pipeline bounds it and flags control and direction characters). Nothing here reads it for instructions,
 *    or puts it in a message.
 *
 * The sign is Stripe's: an amount is negative when money leaves the account and positive when it comes in, which is the pipeline's own rule ("positive is money into
 * the account"). That is Stripe's documented example (`"amount": -1000` for a payment out of the account); how a credit card's purchases are signed is read from
 * `signedCents` alone, so that the answer from a real card is changed in one place. */

export const PROVIDER = "bank";

/** The provider account key of a bank connection's account: the provider, a colon, and Stripe's identifier. Null when the identifier cannot be a key. */
export function accountKeyOf(accountId: string): string | null {
  return /^[A-Za-z0-9_]{3,64}$/.test(accountId) ? `${PROVIDER}:${accountId}` : null;
}

/** What the pipeline will take as a provider id (see ingest/validate.ts `plainKey`). */
const usableId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 256 &&
  value.trim() === value &&
  !hasControlCharacters(value);

const currencyOf = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;

/** The signed cents of a transaction as the pipeline wants them: positive when money comes into the account. */
export function signedCents(_kind: BankAccountOffer["kind"], cents: number): bigint {
  return BigInt(cents);
}

export interface HeldTransaction {
  /** Stable per transaction: `id:<id>` or, with no usable id, a hash of what was sent. */
  readonly key: string;
  readonly id: string | null;
  readonly postedOn: string | null;
  /** Why it was not imported, in words. Never quotes the transaction's text. */
  readonly reason: string;
}

export interface Counts {
  /** Transactions the call listed. */
  readonly received: number;
  /** Lines produced. */
  readonly imported: number;
  /** Pending or voided: left for when the bank has posted them. */
  readonly pending: number;
  /** The same identifier and the same facts a second time in one call: counted once. */
  readonly repeated: number;
  readonly held: number;
}

export interface Normalised {
  readonly lines: readonly BankLine[];
  readonly held: readonly HeldTransaction[];
  readonly counts: Counts;
}

const bounded = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) : text;

/** The most unreadable transactions of one call that are listed by name; the count is always exact. */
const MAX_HELD_KEPT = 200;

export function normaliseTransactions(
  account: Pick<BankAccountOffer, "kind">,
  transactions: readonly BankTransaction[],
  options: { readonly accountKey: string },
): Normalised {
  const lines: BankLine[] = [];
  const held: HeldTransaction[] = [];
  const first = new Map<string, string>();
  let pending = 0;
  let repeated = 0;
  let heldCount = 0;
  const hold = (key: string, id: string | null, postedOn: string | null, reason: string): void => {
    heldCount += 1;
    if (held.length < MAX_HELD_KEPT) held.push({ key, id, postedOn, reason });
  };

  for (const [index, entry] of transactions.entries()) {
    const raw = JSON.stringify(entry);
    if (entry === null || typeof entry !== "object" || !usableId(entry.id)) {
      hold(
        `raw:${sha256Hex(raw ?? "").slice(0, 16)}`,
        null,
        null,
        "It has no usable identifier, so it could not be told apart from another line.",
      );
      continue;
    }
    const id = entry.id;
    const key = `id:${id}`;
    if (entry.status !== "posted") {
      pending += 1;
      continue;
    }
    const stamp = entry.postedAt ?? entry.transactedAt;
    if (!isPlausibleEpoch(stamp)) {
      hold(key, id, null, "Its date is missing or is not a whole number of seconds since 1970.");
      continue;
    }
    const postedOn = utcDate(stamp);
    if (!Number.isSafeInteger(entry.amount)) {
      hold(
        key,
        id,
        postedOn,
        "Its amount is not a whole number of cents, so it cannot be written exactly and was not imported.",
      );
      continue;
    }
    const currency = currencyOf(entry.currency);
    if (currency === null) {
      hold(key, id, postedOn, "Its currency is not a three-letter code, so it was not imported.");
      continue;
    }
    const amount = formatMoney(signedCents(account.kind, entry.amount));
    const facts = `${postedOn}|${amount}`;
    const earlier = first.get(id);
    if (earlier !== undefined && earlier === facts) {
      repeated += 1;
      continue;
    }
    if (earlier === undefined) first.set(id, facts);
    // A repeat of an identifier with different facts is kept: the pipeline records it as a line the provider now reports differently, which is the honest outcome.
    lines.push({
      kind: "bankLine",
      provider: PROVIDER,
      accountKey: options.accountKey,
      providerId: id,
      rawIndex: index,
      excerpt: bounded(raw, 4000),
      postedOn,
      amount,
      currency,
      description: typeof entry.description === "string" ? entry.description : "",
    });
  }

  return {
    lines,
    held,
    counts: {
      received: transactions.length,
      imported: lines.length,
      pending,
      repeated,
      held: heldCount,
    },
  };
}

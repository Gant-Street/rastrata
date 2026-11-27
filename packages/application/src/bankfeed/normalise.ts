import { sha256Hex } from "../ingest/hash.ts";
import { hasControlCharacters } from "../ingest/text.ts";
import type { BalanceCheck, BankLine } from "../ingest-types.ts";
import { amountToMoney } from "./amount.ts";
import { ACCOUNT_KEY_PREFIX, PROVIDER } from "./constants.ts";
import type { BridgeAccount } from "./decode.ts";
import { safeText } from "./redact.ts";
import { type Window, isPlausibleEpoch, utcDate } from "./time.ts";

/** The Bridge's account and transactions as lines for the ingestion pipeline. Pure: no clock, no
 * network, no book.
 *
 * What it will not do, and why:
 *  - **Import a pending transaction.** Pending items are not requested (`pending=1` is never sent),
 *    and any that arrive anyway (`pending: true`, or a `posted` of 0, which the protocol says means
 *    pending) are counted and left out. The protocol does not say what happens to a pending item's id
 *    when it posts; a line imported under an id that later changes would be imported twice.
 *  - **Round.** An amount that is not exact in hundredths, or not a decimal string, makes that one
 *    transaction unreadable. It is *held*: reported with its id and the reason, never imported, never
 *    skipped silently, and it never stops the rest of the account.
 *  - **Convert.** A line carries the account's own currency. If it is not the book's, the pipeline
 *    flags it `foreign_currency` and nothing can be proposed or posted without a person; the
 *    account's balance is then not offered as a check, because it is in another currency.
 *  - **Obey text.** Descriptions are stored as received (the pipeline bounds them and flags control
 *    and direction characters). Nothing here reads them for instructions, or puts them in a message. */

/** The provider account key of a Bridge account id: `simplefin:` and the id percent-encoded, so an
 * id with spaces or control characters (the demo's is `Demo Checking`) is a safe, stable key. Null
 * when the id cannot be a key (too long, or not valid text). */
export function accountKeyOf(accountId: string): string | null {
  let encoded: string;
  try {
    encoded = encodeURIComponent(accountId);
  } catch {
    return null;
  }
  const key = `${ACCOUNT_KEY_PREFIX}${encoded}`;
  return key.length <= 200 ? key : null;
}

/** ISO 4217 as three capital letters, or null for anything else (the protocol allows a custom
 * currency written as a URL, which a line cannot carry). */
export function currencyOf(value: string): string | null {
  return /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
}

/** What the pipeline will take as a provider id (see ingest/validate.ts `plainKey`). */
const usableId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 256 &&
  value.trim() === value &&
  !hasControlCharacters(value);

export interface HeldTransaction {
  /** Stable per transaction: `id:<id>` or, with no usable id, a hash of what was sent. */
  readonly key: string;
  readonly id: string | null;
  readonly postedOn: string | null;
  /** Why it was not imported, in words. Never quotes the transaction's text. */
  readonly reason: string;
}

export interface Counts {
  /** Transactions the answer listed. */
  readonly received: number;
  /** Lines produced. */
  readonly imported: number;
  /** Pending, or not yet posted: left for when the bank posts them. */
  readonly pending: number;
  /** Posted at or after the end of the window: read by a later window, so not imported yet. */
  readonly afterWindow: number;
  /** The same id and the same facts a second time in one answer: counted once. */
  readonly repeated: number;
  readonly held: number;
}

export interface Normalised {
  readonly lines: readonly BankLine[];
  /** The account's reported balance as a check on the books, or null. */
  readonly balance: BalanceCheck | null;
  readonly held: readonly HeldTransaction[];
  readonly counts: Counts;
  /** The account's ISO currency, or null when it is a custom one. */
  readonly currency: string | null;
  /** False when the answer carried no list of transactions at all: nothing can be said about the
   * window, so the cursor must not move. */
  readonly listed: boolean;
}

export interface NormaliseOptions {
  readonly accountKey: string;
  readonly bookCurrency: string;
  /** What was asked for. Posted at or after `to` is not read yet. */
  readonly window: Window;
  /** The last window of a run: its balance is offered as a check, because everything up to now has
   * been read by then. An earlier window's balance would only show a difference that the later
   * windows are about to explain. */
  readonly attachBalance: boolean;
}

const bounded = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) : text;

/** How many unreadable transactions of one answer are listed by name; the count is always exact. */
const MAX_HELD_KEPT = 200;

export function normaliseAccount(account: BridgeAccount, options: NormaliseOptions): Normalised {
  const currency = currencyOf(account.currency);
  const lines: BankLine[] = [];
  const held: HeldTransaction[] = [];
  const first = new Map<string, string>();
  let pending = 0;
  let afterWindow = 0;
  let repeated = 0;
  const listed = account.transactions !== null;

  let heldCount = 0;
  const hold = (key: string, id: string | null, postedOn: string | null, reason: string): void => {
    heldCount += 1;
    // Only the first few are kept to show; the count is exact.
    if (held.length < MAX_HELD_KEPT)
      held.push({ key, id: id === null ? null : safeText(id, { max: 80 }), postedOn, reason });
  };

  if (currency !== null)
    for (const [index, entry] of (account.transactions ?? []).entries()) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        hold(
          `raw:${sha256Hex(JSON.stringify(entry) ?? "").slice(0, 16)}`,
          null,
          null,
          "It was not an object.",
        );
        continue;
      }
      const tx = entry as Record<string, unknown>;
      const id = tx.id;
      const raw = JSON.stringify(tx);
      if (!usableId(id)) {
        hold(
          `raw:${sha256Hex(raw).slice(0, 16)}`,
          null,
          null,
          "It has no usable id, so it could not be told apart from another line.",
        );
        continue;
      }
      const key = `id:${id}`;
      // Pending (or not yet posted) items are not imported; see the note at the top. A `posted` of
      // 0 is how the protocol says a pending item has no posting date yet.
      const posted = tx.posted;
      if (tx.pending === true || posted === 0) {
        pending += 1;
        continue;
      }
      if (!isPlausibleEpoch(posted)) {
        hold(
          key,
          id,
          null,
          "Its posted date is missing or is not a whole number of seconds since 1970.",
        );
        continue;
      }
      if (posted >= options.window.to) {
        afterWindow += 1;
        continue;
      }
      const amount = amountToMoney(tx.amount);
      if (amount === null) {
        hold(
          key,
          id,
          utcDate(posted),
          typeof tx.amount === "string"
            ? "Its amount is not a plain decimal with at most two decimal places, so it cannot be written exactly in cents and was not imported."
            : "Its amount is not written as a decimal string, so its digits cannot be trusted and it was not imported.",
        );
        continue;
      }
      const postedOn = utcDate(posted);
      const facts = `${postedOn}|${amount}`;
      const earlier = first.get(id);
      if (earlier !== undefined && earlier === facts) {
        repeated += 1;
        continue;
      }
      if (earlier === undefined) first.set(id, facts);
      // A repeat of an id with different facts is kept: the pipeline records it as a line the
      // provider now reports differently, which is the honest outcome.
      const description = typeof tx.description === "string" ? tx.description : "";
      const payee = typeof tx.payee === "string" ? tx.payee : "";
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
        description,
        ...(payee !== "" && payee !== description ? { counterparty: payee } : {}),
      });
    }

  // The balance is a check only when it is exact and in the book's currency.
  const balanceMoney = amountToMoney(account.balance);
  const stamp = account.balanceDate;
  const balance: BalanceCheck | null =
    options.attachBalance &&
    currency === options.bookCurrency &&
    balanceMoney !== null &&
    isPlausibleEpoch(stamp)
      ? { accountKey: options.accountKey, asOf: utcDate(stamp), balance: balanceMoney }
      : null;

  return {
    lines,
    balance,
    held,
    counts: {
      received: account.transactions?.length ?? 0,
      imported: lines.length,
      pending,
      afterWindow,
      repeated,
      held: heldCount,
    },
    currency,
    listed,
  };
}

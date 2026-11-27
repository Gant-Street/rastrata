import { amountToMoney } from "./amount.ts";
import { type BridgeClient, BridgeError } from "./client.ts";
import { type AccountSet, decodeAccountSet, duplicateIds } from "./decode.ts";
import { accountKeyOf, currencyOf } from "./normalise.ts";
import { isPlausibleEpoch, utcDate } from "./time.ts";

/** Which accounts the Bridge lists, with their balances and no transactions (`balances-only=1`, the
 * cheapest request there is). Reading accounts moves no money and imports nothing: it only says what
 * could be linked.
 *
 * An account Rastrata cannot book is still listed, with the reason, so a person is not left wondering
 * why it is missing:
 *  - `custom_currency`: its currency is not a national currency (the protocol allows a URL);
 *  - `bad_id`: its id cannot be made into a key;
 *  - `ambiguous`: another account in the same answer has the same id, so neither can be asked for. */
export type Support = "ok" | "custom_currency" | "bad_id" | "ambiguous";

export interface ListedAccount {
  readonly id: string;
  /** `simplefin:<id>`, or null when `support` is `bad_id`. */
  readonly key: string | null;
  readonly name: string;
  readonly orgName: string | null;
  readonly orgId: string | null;
  readonly connId: string | null;
  /** As sent. */
  readonly currency: string;
  /** The ISO code in capitals, or null for a custom currency. */
  readonly isoCurrency: string | null;
  /** Two places, or null when what was sent is not an exact decimal string. */
  readonly balance: string | null;
  /** The UTC date of the balance's own date, or null. */
  readonly balanceOn: string | null;
  readonly support: Support;
}

export interface Listing {
  readonly bytes: Uint8Array;
  readonly set: AccountSet;
  readonly accounts: readonly ListedAccount[];
}

export function listedAccounts(set: AccountSet): ListedAccount[] {
  const repeated = duplicateIds(set.accounts);
  return set.accounts.map((account) => {
    const key = accountKeyOf(account.id);
    const iso = currencyOf(account.currency);
    const support: Support = repeated.has(account.id)
      ? "ambiguous"
      : key === null
        ? "bad_id"
        : iso === null
          ? "custom_currency"
          : "ok";
    return {
      id: account.id,
      key,
      name: account.name,
      orgName: account.orgName,
      orgId: account.orgId,
      connId: account.connId,
      currency: account.currency,
      isoCurrency: iso,
      balance: amountToMoney(account.balance),
      balanceOn: isPlausibleEpoch(account.balanceDate) ? utcDate(account.balanceDate) : null,
      support,
    };
  });
}

/** Ask the Bridge which accounts exist: one request. */
export async function listAccounts(
  client: BridgeClient,
  secrets: readonly string[],
): Promise<Listing> {
  const fetched = await client.accounts({ balancesOnly: true });
  const decoded = decodeAccountSet(fetched.json, secrets);
  if (!decoded.ok) throw new BridgeError("bankfeed_bad_response", decoded.problem, false);
  return { bytes: fetched.bytes, set: decoded.value, accounts: listedAccounts(decoded.value) };
}

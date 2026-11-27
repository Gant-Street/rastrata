/** Who a payment went to, from the text a bank wrote: the matcher the 1099 totals use.
 *
 * The matcher is the whole book's now (every report by payee uses it), so it lives in `payees/match.ts`.
 * This file keeps the names the 1099 code and its tests have always imported, with the same behaviour. */
export {
  PAYEE_KEY_MAX,
  PAYEE_KEY_MIN,
  PAYEE_TEXT_MAX,
  groupKey,
  matchVendor,
  payeeKey,
  payeeText,
  payeeWords,
  type KeyedVendor,
  type VendorMatch,
} from "../payees/match.ts";

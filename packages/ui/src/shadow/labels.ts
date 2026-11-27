/** Small helpers the shadow components share: how an account is named in a row or a sentence, and the
 * id of a balance field. Money is not formatted here: every figure is shown through the shared
 * formatter (`../format`), so the same amount reads the same way on every screen. */
import { formatMoney, isZeroMoney } from "../format";
import { listAccountLabel } from "../entries/display";

/** An amount for a column of debits or credits: nothing for zero, so a line shows only its side. */
export const sideAmount = (amount: string): string =>
  amount === "" || isZeroMoney(amount) ? "" : formatMoney(amount);

/** The label of an account in a sentence or a row: its name, with its number first only when the owner
 * asked for numbers. The code stays in the chart, the pickers and the reports. */
export const accountLabel = (account: { readonly code: string; readonly name: string }): string =>
  listAccountLabel(account.name, account.code);

/** An id that is safe to put in an attribute or a URL fragment. */
export const slug = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "_");

/** The id of an account's balance input, so a problem about the account can link to it. */
export const balanceInputId = (accountId: string): string => `rt-shadow-balance-${slug(accountId)}`;

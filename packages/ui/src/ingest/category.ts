import { listAccountLabel } from "../entries/display";
import type { AccountOption, InboxItemView, InboxLegView } from "./types";

/** What a transaction in For review is, or would be, booked to: the one thing the list's Category
 * column says. It is read from the suggestion while a transaction waits, and from the decision once it
 * has been drafted or posted, so the column keeps its answer as the transaction moves along. The line's
 * own account is left out (a bank line always books against itself); what is left is where the money
 * went. Pure: no markup, no wording (the words are in `words.ts`). */
export type CategoryKind =
  /** One account: "Software and subscriptions". */
  | "account"
  /** Several accounts: a split. */
  | "split"
  /** The other account of a transfer between two of your own accounts. */
  | "transfer"
  /** The entry is already in the books: nothing new would be booked. */
  | "match"
  /** Set aside, not booked. */
  | "exclude"
  /** A provider's own entry (a Stripe payout), booked as the provider describes it. */
  | "event"
  /** Nothing is suggested or decided yet. */
  | "none";

export interface Category {
  readonly kind: CategoryKind;
  /** The account names it books to, in order: one for an account or a transfer, several for a split. */
  readonly names: readonly string[];
  /** For a transfer: the money left this account (it goes "to" the other) or came into it ("from"). */
  readonly direction?: "to" | "from";
}

const waiting = (item: InboxItemView): boolean =>
  item.status === "new" || item.status === "proposed";

/** The legs the item books: a suggestion's while it waits, the decision's after. */
function legsOf(item: InboxItemView): readonly InboxLegView[] {
  return (waiting(item) ? item.suggestion?.legs : item.decision?.legs) ?? [];
}

/** The name a person knows an account by in a list: its name (with its number before it when the owner
 * asked for numbers), or whatever identifies it when the chart does not list it. */
export function nameOfAccount(accounts: readonly AccountOption[], id: string): string {
  const found = accounts.find((account) => account.value === id);
  if (!found) return id;
  return listAccountLabel(found.label, found.code);
}

export function categoryOf(item: InboxItemView, nameOf: (accountId: string) => string): Category {
  const kind = waiting(item) ? item.suggestion?.kind : undefined;
  const decided = waiting(item) ? undefined : item.decision?.kind;
  if (kind === "match" || decided === "match") return { kind: "match", names: [] };
  if (kind === "exclude" || decided === "exclude") return { kind: "exclude", names: [] };
  if (item.line.kind === "event") return { kind: "event", names: [] };
  const others = legsOf(item).filter((leg) => leg.accountId !== item.ledgerAccountId);
  const names = [...new Set(others.map((leg) => nameOf(leg.accountId)))];
  if (names.length === 0) return { kind: "none", names: [] };
  if (names.length > 1) return { kind: "split", names };
  if (kind === "transfer" || item.pairItemId !== undefined)
    return {
      kind: "transfer",
      names,
      direction: item.line.amount.startsWith("-") ? "to" : "from",
    };
  return { kind: "account", names };
}

/** Whether a category can be chosen for the transaction where it is listed: a bank transaction whose account
 * is in the books, in the book's own currency and for an amount. The others are decided another way (a
 * provider's entry is accepted as it is, a transaction in another currency is set aside or booked by hand). */
export function categorizable(item: InboxItemView): boolean {
  if (item.line.kind !== "bankLine" || item.ledgerAccountId === null) return false;
  return !item.flags.includes("foreign_currency") && !item.flags.includes("zero_amount");
}

/** The one account a waiting transaction's suggestion books to, when the suggestion is one category and
 * nothing else (not a split, a transfer, an entry already in the books or a provider's own entry): what the
 * category field on its row starts with. */
export function suggestedCategory(item: InboxItemView): string | undefined {
  if (!waiting(item) || item.suggestion?.kind !== "categorize") return undefined;
  if (item.pairItemId !== undefined || item.line.kind === "event") return undefined;
  const others = new Set(
    legsOf(item)
      .filter((leg) => leg.accountId !== item.ledgerAccountId)
      .map((leg) => leg.accountId),
  );
  const [only] = [...others];
  return others.size === 1 ? only : undefined;
}

/** Whether the transaction's row has a category field: it waits for a decision, a category can be chosen
 * for it, and what is suggested (if anything is) is one category. A suggestion that is not one category
 * (a split, a transfer, an entry already in the books) is said as text, and is changed in the pane. */
export function hasCategoryField(item: InboxItemView): boolean {
  if (!waiting(item) || item.coveredBy !== undefined || !categorizable(item)) return false;
  const suggested = item.status === "proposed" && item.suggestion !== undefined;
  return suggested ? suggestedCategory(item) !== undefined : true;
}

/** Whether a row can be accepted as it reads: it carries a suggestion, or a category was chosen on it
 * (`chosen`, the account's id). A transaction booked with its payout is never accepted by itself. */
export function acceptable(item: InboxItemView, chosen: string | undefined): boolean {
  if (!waiting(item) || item.coveredBy !== undefined) return false;
  if (item.status === "proposed" && item.suggestion !== undefined) return true;
  return hasCategoryField(item) && chosen !== undefined && chosen !== "";
}

/** The roles whose balance rises with a debit. Everything else (liabilities, equity, income, gains) rises
 * with a credit. */
const DEBIT_NORMAL: ReadonlySet<string> = new Set(["asset", "expense"]);

/** What an entry does to one account, as a person reads it: a positive amount when the account's balance
 * goes up and a negative one when it goes down, whichever side of the books it is on, so "Business
 * checking +498.75, Sales +498.75" says a sale was received. `amount` is the ledger's wire amount (a
 * debit is positive) and `role` the account's own (`AccountOption.role`); an account whose role is
 * unknown keeps the ledger's sign. The result is a wire amount: set it with `formatMoney`. */
export function effectOf(amount: string, role: string | undefined): string {
  const negative = amount.startsWith("-");
  const debit = !negative;
  const up = role === undefined ? debit : DEBIT_NORMAL.has(role) ? debit : !debit;
  const digits = negative ? amount.slice(1) : amount;
  return up ? digits : `-${digits}`;
}

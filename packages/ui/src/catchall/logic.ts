import { formatMoney } from "../format";
import type { ChecklistView } from "../shadow/types";
import type { ChecklistNoteView, CloseNote, MoveRow, PlaceKind } from "./types";
import { catchallWords } from "./words";

/** The catch-all screens, as pure decisions: what Close the books says about a catch-all account, and what a
 * change of account reads like at each stage. Nothing here reads the book, the clock or the screen. */

/** Where the list of transactions behind a note is. The host knows its addresses, and whether it has the
 * screen at all. */
export interface NoteLinks {
  readonly transactions:
    | ((account: { readonly id: string }, from: string, to: string) => string)
    | undefined;
}

/** What a place in a note says after its name: a bank's text that no payee owns yet says so. */
export function placeDetail(kind: PlaceKind): string | undefined {
  const w = catchallWords.notes;
  return kind === "unnamed" ? w.unnamed : kind === "ambiguous" ? w.ambiguous : undefined;
}

/** The notes of a month's checklist as Close the books shows them. A note that says the account could not
 * be checked is shown as that: it is never dropped, and it never reads as a pass. */
export function closeNotes(view: ChecklistView, links: NoteLinks): CloseNote[] {
  const w = catchallWords.notes;
  const period = view.period;
  const label = period?.label ?? "";
  return (view.notes ?? []).map((note: ChecklistNoteView): CloseNote => {
    const account = note.account.name;
    const id = `${note.code}-${note.account.id}`;
    if (note.code === "catchall_not_checked")
      return {
        id,
        state: "not_checked",
        accountName: account,
        title: w.notCheckedTitle(account),
        text: w.notChecked(account, label),
        largest: [],
      };
    const href =
      links.transactions !== undefined && note.from !== undefined && note.to !== undefined
        ? links.transactions(note.account, note.from, note.to)
        : undefined;
    return {
      id,
      state: "found",
      accountName: account,
      title: w.holdsTitle(account),
      text:
        note.amount !== undefined && note.transactions !== undefined
          ? w.holds(
              account,
              formatMoney(note.amount),
              note.transactions,
              label,
              period !== null && !period.ended,
            )
          : w.holdsTitle(account),
      // The figures stay as the service wrote them; `Money` sets them.
      largest: note.largest.map((place) => ({ ...place })),
      ...(href !== undefined ? { href } : {}),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// a change of account

/** The transactions of a plan that would move. */
export const moving = (rows: readonly MoveRow[]): MoveRow[] =>
  rows.filter((row) => row.outcome === "would_apply");

/** The one sentence over a plan: how many will move, and how many cannot. */
export function planSentence(rows: readonly MoveRow[], target: string): string {
  const w = catchallWords.change.plan;
  const going = moving(rows).length;
  if (going === 0) return w.none(rows.length, target);
  if (going === rows.length) return w.all(going, target);
  return w.some(going, rows.length, target);
}

/** Of what was done, the transactions that are now on the new account and those that are not. */
export function doneSplit(rows: readonly MoveRow[]): {
  readonly moved: MoveRow[];
  readonly notMoved: MoveRow[];
} {
  return {
    moved: rows.filter((row) => row.outcome === "applied"),
    notMoved: rows.filter((row) => row.outcome !== "applied"),
  };
}

/** The words that say where a transaction that is not on its new account was left. */
export function leftWords(left: MoveRow["left"]): string | undefined {
  const w = catchallWords.change.plan.left;
  return left === "review" ? w.review : left === "ready" ? w.ready : undefined;
}

/** Whether an entry on the Transactions list can be moved by a change of account: it came from a bank
 * line (the types the service gives are `bank`, `stripe`, `manual` and `opening`), it is posted, and no
 * reversal links it, whether it is the original or the reversal. The service decides the rest, and says
 * why, in the plan. */
export function canChangeAccount(
  entry: { readonly type?: string | undefined; readonly status: string },
  linked: boolean,
): boolean {
  return entry.type === "bank" && entry.status === "Posted" && !linked;
}

/** How a watched account is marked: the roles the book can watch, and the key that marks each. */
export const WATCH_KEYS = { expense: "catchall.expense", income: "catchall.income" } as const;
export type WatchKind = keyof typeof WATCH_KEYS;

/** The kind of account that can be watched (money that fits nowhere else is an expense or income), or
 * null for the others. */
export const watchKind = (role: string): WatchKind | null =>
  role === "expense" ? "expense" : role === "income" ? "income" : null;

/** Whether the key marks a watched account. */
export const isWatchKey = (roleKey: string | undefined): boolean =>
  roleKey === WATCH_KEYS.expense || roleKey === WATCH_KEYS.income;

/** What can be done about watching an account, given what the account is and what marks it now. An account
 * that already has a different key (the Stripe balance, say) is never offered: the mark is one key, and
 * putting this one on it would take the other off. */
export function watchOffer(account: {
  readonly role: string;
  readonly closedOn?: string | null | undefined;
  readonly roleKey?: string | undefined;
}): "watch" | "stop" | null {
  if (isWatchKey(account.roleKey)) return "stop";
  if (account.closedOn || watchKind(account.role) === null) return null;
  return account.roleKey ? null : "watch";
}

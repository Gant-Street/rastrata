/** What the status of an account says about the postings of it that are cleared, kept current as the book and the
 * cleared set move, so that the status of an account is read from three numbers and not by looking at every
 * posting of the account.
 *
 * An account's status says how many of its postings are uncleared, what they add up to and the date of the oldest.
 * What the cleared ones are is the reconcile slice's own state (`recon_active`); what the account's postings are is
 * the book's. Both only ever grow in a way that is cheap to follow: a posting that arrives is not cleared, so it can
 * only make the oldest uncleared date earlier and changes nothing else; and the cleared set changes only when a
 * reconciliation is completed or voided (`ReconcileStore.clearedGeneration`), which is when the figures are made
 * again from every posting of the account, once. A change that takes a posting out of the lists (a superseding
 * correction) or that can change which accounts are reconciled (a configuration) starts the figures again too.
 *
 * One set of figures is kept for each book and moved on in place, as `calendar/period-entries.ts` does: asked for the
 * state that follows the one it stands at (the next revisions of the same hash chain) it takes in the postings those
 * revisions added, and asked for anything else it is made from the state it is asked for. Held to the reading of
 * every posting by `test/reconcile-figures.test.ts`. */
import type { BookState } from "@rastrata/kernel";
import {
  deltaOf,
  positionOf,
  revisionsAfter,
  type Position,
} from "../../reports/ledger-history.ts";
import { type BookAccount, type BookIndex, effect } from "./book.ts";

/** What an account's cleared postings come to, and the oldest of the others. */
export interface Figures {
  /** How many of the account's postings in the book's list are cleared. */
  readonly cleared: number;
  /** What those add up to, as they change the statement's balance. */
  readonly clearedEffect: bigint;
  /** The date of the oldest posting of the list that is not cleared, or null when every one is. */
  readonly oldest: string | null;
}

class Held {
  readonly accounts = new Map<string, Figures>();
  constructor(
    public position: Position,
    readonly generation: string,
  ) {}
}

const kept = new WeakMap<object, Held>();

/** How many times the figures of an account were made from every posting of it in this process. A test reads it before
 * and after a look to say that the look did not start over. It carries no accounting meaning. */
const made = { fromEveryPosting: 0 };
export const figuresMade = (): number => made.fromEveryPosting;

/** The figures of one account at this state of the book, with the cleared set of this generation. `cleared` is asked
 * for only when the figures have to be made from every posting. */
export function clearedFigures(input: {
  readonly state: BookState;
  readonly book: BookIndex;
  readonly generation: string;
  readonly account: BookAccount;
  readonly cleared: () => ReadonlySet<string>;
}): Figures {
  const { state, book, generation, account } = input;
  const held = kept.get(state.identity);
  if (held && held.generation === generation) {
    const revisions = revisionsAfter(state, held.position);
    if (revisions !== null) {
      if (revisions.length > 0) {
        const delta = deltaOf(revisions);
        if (
          delta.configurations.length > 0 ||
          delta.links.some((link) => link.kind === "supersession")
        )
          held.accounts.clear();
        else
          for (const booked of delta.journals)
            for (const posting of booked.journal.postings) {
              const known = held.accounts.get(posting.accountId as string);
              // A posting of nothing is not in the account's list; every other new posting is uncleared.
              if (!known || posting.bookValue.amount.coefficient === 0n) continue;
              const date = booked.journal.accountingDate as string;
              if (known.oldest === null || date < known.oldest)
                held.accounts.set(posting.accountId as string, { ...known, oldest: date });
            }
        held.position = positionOf(state);
      }
      const known = held.accounts.get(account.id);
      if (known) return known;
      const figures = fromEveryPosting(book, account, input.cleared());
      held.accounts.set(account.id, figures);
      return figures;
    }
  }
  const fresh = new Held(positionOf(state), generation);
  const figures = fromEveryPosting(book, account, input.cleared());
  fresh.accounts.set(account.id, figures);
  // A state older than the one kept (a read pinned to an earlier revision) is answered and not remembered.
  if (!held || fresh.position.revision >= held.position.revision) kept.set(state.identity, fresh);
  return figures;
}

/** The figures made from every posting of the account, as the status was made before they were kept. */
function fromEveryPosting(
  book: BookIndex,
  account: BookAccount,
  cleared: ReadonlySet<string>,
): Figures {
  made.fromEveryPosting += 1;
  let count = 0;
  let total = 0n;
  let oldest: string | null = null;
  for (const posting of book.postings.get(account.id) ?? []) {
    if (cleared.has(posting.postingId)) {
      count += 1;
      total += effect(posting, account);
    } else oldest ??= posting.date;
  }
  return { cleared: count, clearedEffect: total, oldest };
}

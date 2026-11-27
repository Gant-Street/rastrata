import type { BookedJournal, BookState } from "@rastrata/kernel";
import { carriedBy } from "../../carried.ts";
import { ApplicationError } from "../../errors.ts";
import type { ApplicationService } from "../../service.ts";
import { statementAmount } from "../../reconcile/engine.ts";
import type { Delta } from "../../reports/ledger-history.ts";

/** What a reconciliation needs to know about the book, read once and shared. Postings are the
 * ledger's, immutable and identified by id; nothing here is a copy that can drift, because the
 * view is rebuilt whenever the book moves. */
export interface BookAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: string;
  readonly normalSide: "debit" | "credit";
  readonly closedOn: string | null;
}

export interface BookPosting {
  readonly postingId: string;
  readonly journalId: string;
  /** The journal's accounting date, YYYY-MM-DD. */
  readonly date: string;
  readonly narration: string;
  /** Signed ledger cents, debit positive. */
  readonly cents: bigint;
}

/** The part of a view that depends only on a verified book state. */
export interface BookIndex {
  readonly bookRevision: string;
  readonly currency: string;
  /** Every account in the chart. */
  readonly accounts: ReadonlyMap<string, BookAccount>;
  /** The postings of each asset and liability account (the ones a statement can describe),
   * oldest first (date, then posting sequence, then position), leaving out zero amounts and
   * journals a supersession has replaced. */
  readonly postings: ReadonlyMap<string, readonly BookPosting[]>;
  /** The sum of the postings of each account that has any, in ledger cents, kept as the lists are, so that an
   * account's balance is a lookup and not a pass over its postings. A view made by hand may leave it out. */
  readonly totals?: ReadonlyMap<string, bigint>;
}

export interface BookView extends BookIndex {
  /** `${sequence}:${chainHash}` of the ledger head this view was read at. */
  readonly key: string;
  /** The ledger head's sequence: a draft knows the book has moved when it differs. */
  readonly sequence: string;
  /** The verified book state the index was made from. A view made by hand leaves it out, and what is kept current
   * from the book's new revisions (`figures.ts`) is then made from every posting each time it is asked for. */
  readonly state?: BookState;
}

export const headKey = (head: { sequence: string; chainHash: string }): string =>
  `${head.sequence}:${head.chainHash}`;

/** A statement describes money you have (an asset) or money you owe (a liability). */
export const RECONCILABLE_ROLES: ReadonlySet<string> = new Set(["asset", "liability"]);
export const isReconcilable = (account: BookAccount): boolean =>
  RECONCILABLE_ROLES.has(account.role);

/** The Stripe lane's two clearing accounts. Neither has a statement: a payout in transit is cleared
 * by the bank deposit that matches it, and Stripe's own balance is checked by the Stripe lane's
 * balance control (`stripe.status`), so the cash class the chart gives them for the cash-flow
 * statement does not make them accounts to reconcile. Found by role key, as the Stripe lane does. */
const CLEARING_ROLE_KEYS: ReadonlySet<string> = new Set(["stripe.balance", "payouts.in-transit"]);

/** Whether the chart marks an account as a bank account to reconcile: tagged as cash, and not a
 * clearing account. An account that has been reconciled or has a draft is tracked whatever its tags. */
/** Tagged as a bank account or a card: by kind, or (a bank account) as cash for the cash-flow statement.
 * Stripe's clearing accounts are cash too, and are not accounts to reconcile. */
export const isTaggedBankOrCard = (tags: {
  readonly cashFlowClass?: string;
  readonly roleKey?: string;
  readonly kind?: string;
}): boolean =>
  (tags.kind === "bank" || tags.kind === "card" || tags.cashFlowClass === "cash") &&
  !CLEARING_ROLE_KEYS.has(tags.roleKey ?? "");

/** Narration is a bank memo or a person's note: data, shown verbatim but never trusted for
 * length. Cut on a code point so a surrogate pair is never split. */
export function clip(text: string, max = 240): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** A posting in an account's list, with what puts it in its place. */
interface PostingRow {
  readonly sequence: bigint;
  readonly ordinal: bigint;
  readonly posting: BookPosting;
}

/** The row a posting makes in its account's list, or null for a posting of nothing (zero cents). A
 * posting that is not whole cents in the book's currency cannot be read exactly, so it stops the read. */
function postingRow(
  currency: string,
  booked: BookedJournal,
  posting: BookedJournal["journal"]["postings"][number],
): PostingRow | null {
  if (posting.bookValue.functionalCommodityId !== currency || posting.bookValue.amount.scale !== 2n)
    throw new ApplicationError(
      "reconcile_unsupported_amount",
      "This book holds an amount a reconciliation cannot read exactly (not whole cents in the book's currency).",
      409,
    );
  const cents = posting.bookValue.amount.coefficient;
  if (cents === 0n) return null;
  return {
    sequence: booked.postingSequence,
    ordinal: posting.ordinal,
    posting: {
      postingId: posting.id,
      journalId: booked.journal.id,
      date: booked.journal.accountingDate,
      narration: booked.journal.narration,
      cents,
    },
  };
}

/** Within one account the lists are ordered by date, then the entry's number, then the posting's position. */
const inBookOrder = (left: PostingRow, right: PostingRow): number =>
  (left.posting.date < right.posting.date ? -1 : left.posting.date > right.posting.date ? 1 : 0) ||
  (left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0) ||
  (left.ordinal < right.ordinal ? -1 : left.ordinal > right.ordinal ? 1 : 0);

export function buildBookIndex(state: BookState): BookIndex {
  const accounts = new Map<string, BookAccount>();
  for (const account of state.admissionSnapshot.accounts)
    accounts.set(account.id, {
      id: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      normalSide: account.normalSide,
      closedOn: account.closedOn ?? null,
    });
  const superseded = new Set(
    state.corrections
      .filter((link) => link.kind === "supersession")
      .map((link) => link.originalJournalId),
  );
  const rows = new Map<string, PostingRow[]>();
  for (const booked of state.journals) {
    if (superseded.has(booked.journal.id)) continue;
    for (const posting of booked.journal.postings) {
      const account = accounts.get(posting.accountId);
      if (!account || !isReconcilable(account)) continue;
      const row = postingRow(state.identity.functionalCommodityId, booked, posting);
      if (row === null) continue;
      const list = rows.get(posting.accountId) ?? [];
      list.push(row);
      rows.set(posting.accountId, list);
    }
  }
  const postings = new Map<string, readonly BookPosting[]>();
  const totals = new Map<string, bigint>();
  for (const [accountId, list] of rows) {
    list.sort(inBookOrder);
    postings.set(
      accountId,
      list.map((item) => item.posting),
    );
    let sum = 0n;
    for (const item of list) sum += item.posting.cents;
    totals.set(accountId, sum);
  }
  return {
    bookRevision: state.bookRevision.toString(),
    currency: state.identity.functionalCommodityId,
    accounts,
    postings,
    totals,
  };
}

/** The most journals one carrying forward puts in. Past that, building the index again costs about the
 * same and is the simpler thing (a bulk import between two reads of the reconciliation). */
const MOST_CARRIED = 64;

/** The index for the state after `delta`, from the index of the state before it: the new postings are put
 * into the lists of the accounts they touch, in their place by date, sequence and position. Exactly what
 * `buildBookIndex` gives for `state`. Null for the changes that make building it again simpler: a
 * superseding correction (it takes an entry out of the lists), a configuration change (it can change
 * which accounts are reconcilable) and a bulk. */
export function extendBookIndex(
  previous: BookIndex,
  delta: Delta,
  state: BookState,
): BookIndex | null {
  if (
    previous.totals === undefined ||
    delta.configurations.length > 0 ||
    delta.journals.length > MOST_CARRIED ||
    delta.links.some((link) => link.kind === "supersession")
  )
    return null;
  const added = new Map<string, PostingRow[]>();
  for (const booked of delta.journals)
    for (const posting of booked.journal.postings) {
      const account = previous.accounts.get(posting.accountId);
      if (!account || !isReconcilable(account)) continue;
      const row = postingRow(state.identity.functionalCommodityId, booked, posting);
      if (row === null) continue;
      const list = added.get(posting.accountId) ?? [];
      list.push(row);
      added.set(posting.accountId, list);
    }
  const postings = new Map(previous.postings);
  const totals = new Map(previous.totals);
  for (const [accountId, entries] of added) {
    // Within one account the lists are ordered by date, then the entry's number, then the posting's position.
    entries.sort(
      (left, right) =>
        (left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0) ||
        (left.ordinal < right.ordinal ? -1 : left.ordinal > right.ordinal ? 1 : 0),
    );
    const list = [...(previous.postings.get(accountId) ?? [])];
    for (const { posting } of entries) {
      // A new posting comes after every posting dated on or before it: its entry is the newest.
      let low = 0;
      let high = list.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((list[middle] as BookPosting).date <= posting.date) low = middle + 1;
        else high = middle;
      }
      list.splice(low, 0, posting);
    }
    postings.set(accountId, list);
    let sum = totals.get(accountId) ?? 0n;
    for (const { posting } of entries) sum += posting.cents;
    totals.set(accountId, sum);
  }
  return {
    bookRevision: state.bookRevision.toString(),
    currency: previous.currency,
    accounts: previous.accounts,
    postings,
    totals,
  };
}

/** The per-account index derived from one verified book state, made once per state and, when the state
 * is the one before it plus a few commands, from the index of that one (see `carriedBy`). It cannot go
 * stale, and it goes with the book's last state. `readAggregate` is what keeps the state current
 * (incrementally, from the ledger head), so there is no cache of the book here, only of an index
 * computed from it. */
export const bookIndex = carriedBy<BookIndex>({ build: buildBookIndex, extend: extendBookIndex });

/** For each journal a superseding correction replaced, the revision that carried the correction. Empty
 * for a book with none, which is every book this application makes. */
const replacements = new WeakMap<BookState, ReadonlyMap<string, bigint>>();
function replacedAt(state: BookState): ReadonlyMap<string, bigint> {
  const known = replacements.get(state);
  if (known !== undefined) return known;
  const found = new Map<string, bigint>();
  if (state.corrections.some((link) => link.kind === "supersession"))
    for (const revision of state.revisions)
      for (const effect of revision.effects)
        if (effect.type === "correction" && effect.link.kind === "supersession")
          found.set(effect.link.originalJournalId, revision.bookRevision);
  replacements.set(state, found);
  return found;
}

/** The postings of one account in the books as they stood at `revision`: the journals committed at or
 * before it, less those a superseding correction had replaced by then, listed as the index lists them.
 * This is what a reconciliation that finished at that revision could see, worked out from a later state of
 * the same book (a revision never changes, so a later state holds all of it). For the book's own latest
 * revision it is the list the index holds for the account. */
export function accountPostingsAt(
  state: BookState,
  accountId: string,
  revision: bigint,
): BookPosting[] {
  const replaced = replacedAt(state);
  const currency = state.identity.functionalCommodityId;
  const rows: PostingRow[] = [];
  for (const booked of state.journals) {
    if (booked.bookRevision > revision) continue;
    const when = replaced.get(booked.journal.id);
    if (when !== undefined && when <= revision) continue;
    for (const posting of booked.journal.postings) {
      if (posting.accountId !== accountId) continue;
      const row = postingRow(currency, booked, posting);
      if (row !== null) rows.push(row);
    }
  }
  rows.sort(inBookOrder);
  return rows.map((row) => row.posting);
}

/** The book as it stands now. */
export async function loadBookView(service: ApplicationService): Promise<BookView> {
  const { aggregate, head } = await service.readAggregate();
  return {
    ...bookIndex(aggregate.state),
    key: headKey(head),
    sequence: head.sequence,
    state: aggregate.state,
  };
}

/** A posting's effect on the account's statement balance. */
export const effect = (posting: BookPosting, account: BookAccount): bigint =>
  statementAmount(posting.cents, account.normalSide);

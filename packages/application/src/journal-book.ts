import { ExactDecimal, type BookedJournal, type BookState } from "@rastrata/kernel";

import type { SavedDraft } from "./contracts.ts";
import { entryType } from "./journal-type.ts";
import type { LedgerView } from "./reports/ledger.ts";
import { linksOf } from "./reports/ledger-links.ts";
import type { LineRow } from "./reports/ledger-lines.ts";
import { lowerBound, upperBound } from "./reports/ledger-series.ts";

/** The Journal screen's page of entries: the posted entries of the book and the drafts not yet posted,
 * newest first, narrowed by what a person typed. Pure: it reads the book state, the drafts and the
 * references the service gives it, and builds a row only for the entries on the page, so a page costs
 * what the page costs and not the book, however many entries or corrections the book has: an entry is
 * found by its identifier through the book's own lookup, the corrections that concern an entry through
 * an index of them, a page of entries that no search narrows is read from the journals in the order of
 * their dates by position, and one narrowed by an account from the account's own days. A search by a
 * type of entry or by some words looks at each entry in the dates asked for. The service wraps it with
 * the head, the accounts and the scope of the page. */
export const JOURNAL_PAGE_SIZE = 25;

export interface JournalQuery {
  readonly page: number;
  readonly text: string;
  readonly from: string;
  readonly to: string;
  readonly accountId: string;
  readonly status: string;
  readonly type?: string | undefined;
}

export interface JournalBookInput {
  readonly state: BookState;
  /** The book's view, for its journals in date order. */
  readonly view: LedgerView;
  /** The drafts that are not posted, newest first. */
  readonly drafts: readonly SavedDraft[];
  /** What a person typed as the reference of a posted entry, if anything: asked for the entries of the
   * page, and for every entry a search by words looks at. */
  readonly referenceOf: (booked: BookedJournal) => string | undefined;
  /** "1000 · Cash", by account id. */
  readonly accountLabel: ReadonlyMap<string, string>;
  readonly query: JournalQuery;
}

const abs = (coefficient: bigint, scale: bigint) =>
  ExactDecimal.of(coefficient < 0n ? -coefficient : coefficient, scale).toString();

/** The sum of a journal's debits, as the screen shows an entry's amount. */
function debitTextOf(booked: BookedJournal): string {
  let debit = 0n;
  for (const posting of booked.journal.postings)
    if (posting.bookValue.amount.coefficient > 0n) debit += posting.bookValue.amount.coefficient;
  return ExactDecimal.of(debit, 2n).toString();
}

/** The first index of a list ordered by accounting date whose date is not before `date`. */
function firstOnOrAfter(sorted: readonly BookedJournal[], date: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] as BookedJournal).journal.accountingDate < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The first index whose date is after `date`. */
function firstAfter(sorted: readonly BookedJournal[], date: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] as BookedJournal).journal.accountingDate <= date) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** How many journals this process has looked at one by one to find the entries a search wants, which a page that no
 * search narrows, or one narrowed by an account, does not: a test or a bench reads it before and after a look to
 * say that the look was not a pass over the book. It carries no accounting meaning. */
const scanned = { journals: 0 };
export const journalsScanned = (): number => scanned.journals;

export function journalBookPage(input: JournalBookInput) {
  const { state, view, drafts, referenceOf, accountLabel, query } = input;
  const sorted = view.journalsByDate();
  const links = linksOf(state.corrections);
  const lower = query.text.toLowerCase();

  // A journal by its id, for the originals of corrections.
  const journalById = (id: string): BookedJournal | undefined => view.find(id);

  // An entry's number, so a sentence about another entry names it as a person does. Asked only for the
  // journals that corrections name.
  const sequenceOf = (id: string): string | undefined =>
    journalById(id)?.postingSequence.toString();
  const numbered = (journalId: string): string => {
    const sequence = sequenceOf(journalId);
    return sequence === undefined ? journalId : `No. ${sequence}`;
  };

  /** Where an entry came from, if a source made it: the source record of the entry, or of the entry a
   * correction corrects. */
  const sourceIdOf = (booked: BookedJournal): string | undefined => {
    const link = links.firstByCorrection(booked.journal.id);
    const original = link ? journalById(link.originalJournalId) : booked;
    const evidence = original?.derivations
      .flatMap((item) => item.evidence)
      .find((item) => item.sourceSystem === "rastrata-source-v1");
    return evidence && original ? evidence.sourceRecordId : undefined;
  };

  const postedRow = (booked: BookedJournal) => {
    const journal = booked.journal;
    const correctedBy = links.firstByOriginal(journal.id);
    const corrects = links.firstByCorrection(journal.id);
    const debitText = debitTextOf(booked);
    return {
      id: journal.id,
      date: journal.accountingDate,
      isoDate: journal.accountingDate,
      reference: referenceOf(booked) ?? journal.narration,
      postingSequence: booked.postingSequence.toString(),
      description: journal.narration,
      type: entryType(sourceIdOf(booked)),
      amount: debitText,
      status: "Posted" as const,
      lines: journal.postings.map((posting) => ({
        id: posting.id,
        accountId: posting.accountId,
        debit:
          posting.bookValue.amount.coefficient > 0n
            ? abs(posting.bookValue.amount.coefficient, posting.bookValue.amount.scale)
            : null,
        credit:
          posting.bookValue.amount.coefficient < 0n
            ? abs(posting.bookValue.amount.coefficient, posting.bookValue.amount.scale)
            : null,
      })),
      debitTotal: debitText,
      creditTotal: debitText,
      history: [
        { at: journal.recordedAt, description: `Posted at book revision ${booked.bookRevision}` },
        ...(correctedBy
          ? [
              {
                at: journal.recordedAt,
                description: `Reversed by ${numbered(correctedBy.correctionJournalId)}`,
              },
            ]
          : []),
        ...(corrects
          ? [
              {
                at: journal.recordedAt,
                description: `Reversal of ${numbered(corrects.originalJournalId)}`,
              },
            ]
          : []),
      ],
    };
  };

  const draftRow = (draft: SavedDraft) => ({
    id: draft.id,
    date: draft.data.date,
    isoDate: draft.data.date,
    reference: draft.data.reference,
    description: draft.data.narration.trim() || draft.data.reference.trim(),
    type: entryType(draft.data.source?.id),
    amount: "—",
    status: "Draft" as const,
    lines: draft.data.lines.map((line, index) => ({
      id: `${draft.id}-${index}`,
      accountId: line.accountId,
      debit: line.debit || null,
      credit: line.credit || null,
    })),
    debitTotal: "—",
    creditTotal: "—",
    history: [{ at: draft.data.date, description: "Saved draft; not posted" }],
  });

  type Row = ReturnType<typeof postedRow> | ReturnType<typeof draftRow>;

  // What a person can type to find an entry: its identifier, what it says (reference and description),
  // its date, its number ("No. 23" or "#23"), its amount and the accounts it touches.
  const searchable = (entry: Row): string =>
    [
      entry.id,
      entry.reference,
      entry.description,
      entry.date,
      "postingSequence" in entry ? `no. ${entry.postingSequence} #${entry.postingSequence}` : "",
      entry.amount,
      ...entry.lines.map((line) => accountLabel.get(line.accountId) ?? ""),
    ]
      .join(" ")
      .toLowerCase();
  const passes = (entry: Row): boolean =>
    (!query.text || searchable(entry).includes(lower)) &&
    (!query.from || entry.isoDate >= query.from) &&
    (!query.to || entry.isoDate <= query.to) &&
    (!query.accountId || entry.lines.some((line) => line.accountId === query.accountId)) &&
    (!query.status || entry.status === query.status) &&
    (!query.type || entry.type === query.type);

  // Where an entry stands among the others when two have the same date: the order the entries are
  // listed in, posted ones by number and then the drafts, newest first. A draft that is being posted has
  // the id of the entry it is becoming; both then stand where the draft does.
  const entryCount = sorted.length;
  const draftOrder = new Map<string, number>();
  for (const [index, draft] of drafts.entries()) draftOrder.set(draft.id, entryCount + index);
  const orderOf = (id: string, sequence: bigint): number =>
    draftOrder.get(id) ?? Number(sequence) - 1;
  const newerFirst = (
    left: { isoDate: string; order: number },
    right: { isoDate: string; order: number },
  ): number => right.isoDate.localeCompare(left.isoDate) || right.order - left.order;

  // The entries that do not sit in the plain order of the posted ones: every draft, and any posted entry
  // that shares an id with one (a posting whose reply was lost), found by looking each draft's id up.
  const pendingIds = new Set(drafts.map((draft) => draft.id));
  const shared = [...pendingIds].flatMap((id) => {
    const booked = journalById(id);
    return booked === undefined ? [] : [booked];
  });
  const sharedSet = new Set(shared.map((booked) => booked.journal.id));
  const extras = [
    ...[...shared]
      .sort((left, right) => (left.postingSequence < right.postingSequence ? -1 : 1))
      .map((booked) => ({
        row: postedRow(booked),
        order: orderOf(booked.journal.id, booked.postingSequence),
      })),
    ...drafts.map((draft) => ({ row: draftRow(draft), order: draftOrder.get(draft.id) as number })),
  ]
    .filter((item) => passes(item.row))
    .sort((left, right) =>
      newerFirst(
        { isoDate: left.row.isoDate, order: left.order },
        { isoDate: right.row.isoDate, order: right.order },
      ),
    );

  // The posted entries in the plain order, newest first, that pass what was typed.
  const wantsPosted = !query.status || query.status === "Posted";
  const low = query.from ? firstOnOrAfter(sorted, query.from) : 0;
  const high = query.to ? firstAfter(sorted, query.to) : sorted.length;
  const narrowed = Boolean(query.accountId || query.type || query.text) || sharedSet.size > 0;
  let postedCount = 0;
  let postedAt: (index: number) => BookedJournal = () => {
    throw new RangeError("No such entry");
  };
  if (wantsPosted && high > low) {
    if (!narrowed) {
      postedCount = high - low;
      postedAt = (index) => sorted[high - 1 - index] as BookedJournal;
    } else if (query.accountId && !query.type && !query.text) {
      // The entries that touch an account, in the dates asked for, from the account's own days: how many there are
      // is a subtraction of the sums before two days, and the page is read from the newest day back.
      const days = view.accountLines().account(query.accountId);
      const first = days && query.from ? lowerBound(days.dates, query.from) : 0;
      const end = days ? (query.to ? upperBound(days.dates, query.to) : days.dates.length) : 0;
      if (days !== undefined && end > first) {
        // An entry that has two postings on the account is one entry, and an entry that shares its id with a draft
        // is listed where the draft stands.
        const touching = (booked: BookedJournal): boolean =>
          (!query.from || booked.journal.accountingDate >= query.from) &&
          (!query.to || booked.journal.accountingDate <= query.to) &&
          booked.journal.postings.some((posting) => posting.accountId === query.accountId);
        postedCount =
          (days.count[end] as number) -
          (days.count[first] as number) -
          ((days.repeats[end] as number) - (days.repeats[first] as number)) -
          shared.filter(touching).length;
        const walked: BookedJournal[] = [];
        const rowsOf = (day: number): readonly LineRow[] => days.rows[day] as readonly LineRow[];
        let day = end - 1;
        let at = rowsOf(day).length - 1;
        let last: BookedJournal | undefined;
        const next = (): BookedJournal | undefined => {
          while (day >= first) {
            while (at >= 0) {
              const { booked } = rowsOf(day)[at] as LineRow;
              at -= 1;
              if (booked === last) continue;
              last = booked;
              if (!sharedSet.has(booked.journal.id)) return booked;
            }
            day -= 1;
            at = day >= first ? rowsOf(day).length - 1 : -1;
          }
          return undefined;
        };
        postedAt = (index) => {
          while (walked.length <= index) {
            const found = next();
            if (found === undefined) throw new RangeError("No such entry");
            walked.push(found);
          }
          return walked[index] as BookedJournal;
        };
      }
    } else {
      const matches: BookedJournal[] = [];
      for (let at = high - 1; at >= low; at -= 1) {
        scanned.journals += 1;
        const booked = sorted[at] as BookedJournal;
        if (sharedSet.has(booked.journal.id)) continue;
        if (
          query.accountId &&
          !booked.journal.postings.some((posting) => posting.accountId === query.accountId)
        )
          continue;
        if (query.type && entryType(sourceIdOf(booked)) !== query.type) continue;
        if (query.text) {
          const seq = booked.postingSequence.toString();
          const text = [
            booked.journal.id,
            referenceOf(booked) ?? booked.journal.narration,
            booked.journal.narration,
            booked.journal.accountingDate,
            `no. ${seq} #${seq}`,
            debitTextOf(booked),
            ...booked.journal.postings.map((posting) => accountLabel.get(posting.accountId) ?? ""),
          ]
            .join(" ")
            .toLowerCase();
          if (!text.includes(lower)) continue;
        }
        matches.push(booked);
      }
      postedCount = matches.length;
      postedAt = (index) => matches[index] as BookedJournal;
    }
  }

  // The page: merge the two lists in the order the screen shows them, for as many as the page reaches.
  const offset = (query.page - 1) * JOURNAL_PAGE_SIZE;
  const entries: Row[] = [];
  let posted = 0;
  let extra = 0;
  for (let taken = 0; taken < offset + JOURNAL_PAGE_SIZE; taken += 1) {
    const candidate = posted < postedCount ? postedAt(posted) : undefined;
    const other = extras[extra];
    if (candidate === undefined && other === undefined) break;
    const takePosted =
      candidate !== undefined &&
      (other === undefined ||
        newerFirst(
          {
            isoDate: candidate.journal.accountingDate,
            order: Number(candidate.postingSequence) - 1,
          },
          { isoDate: other.row.isoDate, order: other.order },
        ) <= 0);
    if (takePosted) {
      if (taken >= offset) entries.push(postedRow(candidate as BookedJournal));
      posted += 1;
    } else {
      if (taken >= offset) entries.push((other as (typeof extras)[number]).row);
      extra += 1;
    }
  }

  return {
    entries,
    count: postedCount + extras.length,
    drafts: (() => {
      const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
      return entries.flatMap((entry) => {
        const draft = draftById.get(entry.id);
        return draft ? [{ id: draft.id, version: draft.version, status: draft.status }] : [];
      });
    })(),
    // The corrections that name an entry of this page, which is what a screen reads about the entries it
    // shows ("Reversed by No. 29"), in the order the book made them.
    corrections: links.naming(entries.map((entry) => entry.id)).map((link) => {
      const original = sequenceOf(link.originalJournalId);
      const correction = sequenceOf(link.correctionJournalId);
      return {
        originalJournalId: link.originalJournalId,
        correctionJournalId: link.correctionJournalId,
        kind: link.kind,
        ...(original !== undefined ? { originalPostingSequence: original } : {}),
        ...(correction !== undefined ? { correctionPostingSequence: correction } : {}),
      };
    }),
  };
}

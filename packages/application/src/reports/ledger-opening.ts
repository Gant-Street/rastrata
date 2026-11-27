import type { BookedJournal, CorrectionLink } from "@rastrata/kernel";

/** What the ledger keeps with a journal posted from a source, and the start of the source id the
 * opening tools give the one entry that starts a book (`opening-<cutover date>-<hash>`). */
const SOURCE_SYSTEM = "rastrata-source-v1";
export const OPENING_SOURCE_PREFIX = "opening-";

/** The journals that are the book's opening position and not activity: the entry posted from a source
 * whose id starts with `opening-`, and every correction of it, so that reversing it and entering it
 * again leaves the position, never a movement. */
export interface OpeningJournals {
  readonly ids: ReadonlySet<string>;
  /** The journals of `ids` the book holds, in no particular order. */
  readonly journals: readonly BookedJournal[];
}

/** Whether a journal was posted from an opening source. Only the first piece of evidence that names
 * the source system is read. */
function postedAsOpening(booked: BookedJournal): boolean {
  for (const derivation of booked.derivations)
    for (const evidence of derivation.evidence)
      if (evidence.sourceSystem === SOURCE_SYSTEM)
        return evidence.sourceRecordId.startsWith(OPENING_SOURCE_PREFIX);
  return false;
}

/** The opening journals of a whole book. */
export function openingOf(
  journals: readonly BookedJournal[],
  corrections: readonly CorrectionLink[],
): OpeningJournals {
  return extendOpening({ ids: new Set(), journals: [] }, journals, corrections, () => undefined);
}

/** The opening journals after journals and corrections more. A correction of an opening journal is an
 * opening journal, and so is a correction of that, to the end of the chain; only the new links can
 * reach new journals, so only they are read. `find` looks up a journal among those before these. */
export function extendOpening(
  base: OpeningJournals,
  added: readonly BookedJournal[],
  links: readonly CorrectionLink[],
  find: (journalId: string) => BookedJournal | undefined,
): OpeningJournals {
  const ids = new Set(base.ids);
  const journals = [...base.journals];
  const adding = new Map(added.map((booked) => [booked.journal.id as string, booked]));
  for (const booked of added)
    if (postedAsOpening(booked) && !ids.has(booked.journal.id)) {
      ids.add(booked.journal.id);
      journals.push(booked);
    }
  if (ids.size > 0) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const link of links)
        if (
          ids.has(link.originalJournalId as string) &&
          !ids.has(link.correctionJournalId as string)
        ) {
          ids.add(link.correctionJournalId as string);
          const correction = adding.get(link.correctionJournalId) ?? find(link.correctionJournalId);
          if (correction !== undefined) journals.push(correction);
          grew = true;
        }
    }
  }
  return ids.size === base.ids.size ? base : { ids, journals };
}

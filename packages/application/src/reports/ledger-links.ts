import type { CorrectionLink } from "@rastrata/kernel";

/** The corrections of a book by the journals they name, so that a screen that shows a page of entries asks
 * what became of each of them by its identifier and does not read every correction of the book. A link names
 * two journals, the one it corrects (the original) and the one that corrects it. Everything is answered in the
 * order of the book's own list of corrections. */
export class Links {
  private readonly byOriginal = new Map<string, number[]>();
  private readonly byCorrection = new Map<string, number[]>();

  constructor(readonly all: readonly CorrectionLink[]) {
    for (const [at, link] of all.entries()) {
      push(this.byOriginal, link.originalJournalId, at);
      push(this.byCorrection, link.correctionJournalId, at);
    }
  }

  /** The first link, in the book's order, that names this journal as the one it corrects. */
  firstByOriginal(journalId: string): CorrectionLink | undefined {
    const first = this.byOriginal.get(journalId)?.[0];
    return first === undefined ? undefined : this.all[first];
  }

  /** The first link, in the book's order, that names this journal as the correction. */
  firstByCorrection(journalId: string): CorrectionLink | undefined {
    const first = this.byCorrection.get(journalId)?.[0];
    return first === undefined ? undefined : this.all[first];
  }

  /** Every link that names any of these journals, as the original or as the correction, each once, in the
   * book's order. */
  naming(journalIds: Iterable<string>): CorrectionLink[] {
    const places = new Set<number>();
    for (const id of journalIds) {
      for (const at of this.byOriginal.get(id) ?? []) places.add(at);
      for (const at of this.byCorrection.get(id) ?? []) places.add(at);
    }
    return [...places]
      .sort((left, right) => left - right)
      .map((at) => this.all[at] as CorrectionLink);
  }
}

function push(into: Map<string, number[]>, key: string, at: number): void {
  const found = into.get(key);
  if (found === undefined) into.set(key, [at]);
  else found.push(at);
}

const known = new WeakMap<readonly CorrectionLink[], Links>();

/** The index of a book's corrections, made once for each list the kernel hands out: a state keeps the list of the
 * state before it until a correction is made, so the index is made again only when one is, which costs the
 * corrections of the book and is rare. A list that is not frozen may change under the index, so it is indexed
 * for the one use and not kept. */
export function linksOf(corrections: readonly CorrectionLink[]): Links {
  const hit = known.get(corrections);
  if (hit !== undefined) return hit;
  const made = new Links(corrections);
  if (Object.isFrozen(corrections)) known.set(corrections, made);
  return made;
}

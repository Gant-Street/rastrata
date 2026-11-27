/** Overlap detection: recognising lines that were imported before, for sources whose lines carry no
 * identifier of their own (a bank's CSV).
 *
 * hledger's `import` explains why this is not "deduplication": bank CSV has no reliable identity, so
 * two identical lines on one day may be two purchases or one purchase listed twice. hledger
 * remembers, per source, the latest date it imported and how many lines fell on it, and skips what
 * it has already seen. That works while files only grow at the new end. This adapts the idea so it
 * also survives what real files do:
 *
 * - A line's identity is its date, signed amount and currency. Lines with the same identity are
 *   counted, per source: the stored count is how many were imported, the batch's count is how many
 *   this file lists. The first `stored` lines are already imported, the rest are new. This is the
 *   same "skip the first N on that date" rule, applied to every date and amount rather than only to
 *   the latest date, so a late-arriving older line is still imported and an overlapping window or a
 *   re-download adds nothing.
 * - Two purchases for the same amount on the same day are two lines (count 2), not one. They are
 *   only called already imported when both are already stored.
 * - The description is not part of the identity. When a bank or a parser changes how it writes the
 *   description of an old line, the line is still recognised. The description only decides which
 *   stored line a file line pairs with: equal text first, then in order. That keeps the text of the
 *   line that is genuinely new when two lines share a date and amount.
 * - Nothing here guesses at "close enough". A different date or a different amount is a different
 *   line, and the balance check shows the difference if the bank re-dated something.
 *
 * Assumptions, as in hledger: a file is a contiguous window of the account's lines, and the same
 * line keeps its date and amount between downloads. When they do not hold the balance check, which
 * compares the books with the balance the bank reports, is where it shows. */

export interface StoredCandidate {
  /** The stored item's id. */
  readonly id: string;
  /** Normalised-text hash of the stored line. */
  readonly textKey: string;
  /** Its occurrence number among stored lines with the same identity, from 1. */
  readonly occurrence: number;
}

export interface IncomingLine {
  /** Position in the batch (any unique number; used to report the result). */
  readonly index: number;
  /** The line's identity: `date|cents|currency`. */
  readonly fingerprint: string;
  readonly textKey: string;
}

export interface OverlapResult {
  /** Lines already imported, with the stored item each one pairs with. */
  readonly matched: readonly {
    readonly index: number;
    readonly itemId: string;
    /** False when the line pairs with a stored line whose description is different. */
    readonly sameText: boolean;
  }[];
  /** Lines not imported before, with the occurrence number each takes. */
  readonly fresh: readonly { readonly index: number; readonly occurrence: number }[];
}

/** The identity of a line without a provider id. */
export const fingerprintOf = (date: string, cents: bigint, currency: string): string =>
  `${date}|${cents}|${currency}`;

/** Decide, for each incoming line, whether it was imported before. `stored` maps a fingerprint to
 * the stored lines with that fingerprint. Deterministic: the same inputs always give the same
 * answer, in the order of `incoming`. */
export function matchOverlap(
  incoming: readonly IncomingLine[],
  stored: ReadonlyMap<string, readonly StoredCandidate[]>,
): OverlapResult {
  const groups = new Map<string, IncomingLine[]>();
  for (const line of incoming) {
    const group = groups.get(line.fingerprint);
    if (group) group.push(line);
    else groups.set(line.fingerprint, [line]);
  }
  const matched: { index: number; itemId: string; sameText: boolean }[] = [];
  const fresh: { index: number; occurrence: number }[] = [];
  for (const [fingerprint, lines] of groups) {
    const candidates = [...(stored.get(fingerprint) ?? [])].sort(
      (left, right) => left.occurrence - right.occurrence,
    );
    const taken = new Set<string>();
    const paired = new Map<number, { itemId: string; sameText: boolean }>();
    // Equal text first, so the line that is genuinely new keeps its own description.
    for (const line of lines) {
      const candidate = candidates.find(
        (item) => !taken.has(item.id) && item.textKey === line.textKey,
      );
      if (candidate) {
        taken.add(candidate.id);
        paired.set(line.index, { itemId: candidate.id, sameText: true });
      }
    }
    // Then in order, whatever the text says.
    for (const line of lines) {
      if (paired.has(line.index)) continue;
      const candidate = candidates.find((item) => !taken.has(item.id));
      if (!candidate) continue;
      taken.add(candidate.id);
      paired.set(line.index, { itemId: candidate.id, sameText: false });
    }
    let next = candidates.reduce((highest, item) => Math.max(highest, item.occurrence), 0);
    for (const line of lines) {
      const pair = paired.get(line.index);
      if (pair) matched.push({ index: line.index, ...pair });
      else fresh.push({ index: line.index, occurrence: ++next });
    }
  }
  const order = new Map(incoming.map((line, position) => [line.index, position]));
  const byPosition = (left: { index: number }, right: { index: number }) =>
    (order.get(left.index) ?? 0) - (order.get(right.index) ?? 0);
  return { matched: matched.sort(byPosition), fresh: fresh.sort(byPosition) };
}

/** The scoring behind the built-in matchers: a bank line against entries that are already booked,
 * and a bank line against the other side of a transfer between two of the book's own accounts.
 *
 * GnuCash's import matcher is the model. It scores a candidate by amount (exact +3, near +2,
 * mismatch -5), by date (same day +3, near +2, far -5) and by check number (+4), and keeps
 * thresholds for adding, clearing and skipping. Two things are different here on purpose:
 *
 * - Amounts are exact cents or the candidate does not exist. GnuCash compares doubles with an
 *   epsilon, and Bigcapital forgives 0.01 to cover floating point; both are ways to book the wrong
 *   thing. A line that is a cent off is a different line, and the balance check says so.
 * - The weights and thresholds are configuration with tests, not constants buried in the scorer, and
 *   every score carries the reasons that produced it, so a person can see why before accepting.
 *
 * Everything here is pure and deterministic: the same inputs always give the same ranking. */
import { daysBetween, normalizeForKey, tokens } from "./text.ts";

export interface MatchConfig {
  readonly transfer: {
    /** Days between the two sides of a transfer that still count as the same transfer. */
    readonly windowDays: number;
  };
  readonly journal: {
    /** Days between a bank line and an entry that still count as a candidate. */
    readonly windowDays: number;
    /** Days apart that still count as "near" rather than merely in the window. */
    readonly nearDays: number;
    /** The lowest score that becomes a proposal. */
    readonly minScore: number;
    readonly weights: {
      /** The amount is exactly equal: the precondition for being a candidate at all. */
      readonly amountExact: number;
      readonly sameDay: number;
      readonly nearDays: number;
      readonly inWindow: number;
      /** The line's check number or reference appears in the entry's text. */
      readonly reference: number;
      /** Two or more words in common with the entry's text. */
      readonly wordsMany: number;
      readonly wordsOne: number;
    };
  };
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  transfer: { windowDays: 5 },
  journal: {
    windowDays: 10,
    nearDays: 3,
    minScore: 5,
    weights: {
      amountExact: 3,
      sameDay: 3,
      nearDays: 2,
      inWindow: 0,
      reference: 4,
      wordsMany: 2,
      wordsOne: 1,
    },
  },
};

export interface JournalLineFacts {
  readonly date: string;
  readonly text: string;
  readonly reference?: string;
}

export interface JournalFacts {
  readonly id: string;
  readonly date: string;
  readonly narration: string;
}

export interface JournalScore {
  readonly journalId: string;
  readonly score: number;
  readonly days: number;
  readonly reasons: readonly string[];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Score one candidate entry for a bank line. The amount is already known to be exactly equal. */
export function scoreJournal(
  amount: string,
  line: JournalLineFacts,
  candidate: JournalFacts,
  config: MatchConfig,
): JournalScore {
  const weights = config.journal.weights;
  const reasons = [`The amount matches exactly (${amount}).`];
  let score = weights.amountExact;
  const days = Math.abs(daysBetween(line.date, candidate.date));
  if (days === 0) {
    score += weights.sameDay;
    reasons.push("Same date.");
  } else if (days <= config.journal.nearDays) {
    score += weights.nearDays;
    reasons.push(`${plural(days, "day")} apart.`);
  } else {
    score += weights.inWindow;
    reasons.push(`${plural(days, "day")} apart.`);
  }
  const narration = normalizeForKey(candidate.narration);
  const reference = line.reference ? normalizeForKey(line.reference) : "";
  if (reference.length >= 2 && narration.split(/[^\p{L}\p{N}]+/u).includes(reference)) {
    score += weights.reference;
    reasons.push(`The line's reference ${reference} appears in the entry.`);
  }
  const mine = new Set(tokens(line.text));
  const shared = tokens(candidate.narration).filter((word) => mine.has(word));
  if (shared.length >= 2) {
    score += weights.wordsMany;
    reasons.push(`They share the words ${shared.slice(0, 3).join(", ")}.`);
  } else if (shared.length === 1) {
    score += weights.wordsOne;
    reasons.push(`They share the word ${shared[0]}.`);
  }
  return { journalId: candidate.id, score, days, reasons };
}

/** Rank candidates, best first: higher score, then nearer date, then id (so ties are stable), and
 * drop what falls below the threshold. */
export function rankJournals(
  amount: string,
  line: JournalLineFacts,
  candidates: readonly JournalFacts[],
  config: MatchConfig,
): JournalScore[] {
  return candidates
    .map((candidate) => scoreJournal(amount, line, candidate, config))
    .filter((score) => score.score >= config.journal.minScore)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.days - right.days ||
        (left.journalId < right.journalId ? -1 : left.journalId > right.journalId ? 1 : 0),
    );
}

/** A whole percent from a score: more evidence, more confidence, never certainty. When the next
 * best candidate is almost as good the match is ambiguous and is held down. */
export function journalConfidence(ranked: readonly JournalScore[]): number {
  const best = ranked[0];
  if (!best) return 0;
  const raw = Math.min(95, 40 + 8 * best.score);
  const next = ranked[1];
  return next && next.score >= best.score - 1 ? Math.min(raw, 60) : raw;
}

export interface TransferCandidate {
  readonly itemId: string;
  readonly accountId: string;
  readonly date: string;
}

export interface TransferChoice {
  readonly itemId: string;
  readonly confidence: number;
  readonly reasons: readonly string[];
}

/** Choose the other side of a transfer among lines with the opposite amount on other accounts.
 * The caller supplies only candidates with exactly the opposite amount. The nearest date wins;
 * when several are equally near the choice is held down and says so. */
export function chooseTransfer(
  own: { readonly accountId: string; readonly date: string; readonly amount: string },
  candidates: readonly TransferCandidate[],
  config: MatchConfig,
): TransferChoice | null {
  const eligible = candidates
    .filter((candidate) => candidate.accountId !== own.accountId)
    .map((candidate) => ({
      candidate,
      days: Math.abs(daysBetween(own.date, candidate.date)),
    }))
    .filter((entry) => entry.days <= config.transfer.windowDays)
    .sort(
      (left, right) =>
        left.days - right.days || (left.candidate.itemId < right.candidate.itemId ? -1 : 1),
    );
  const best = eligible[0];
  if (!best) return null;
  const tied = eligible.filter((entry) => entry.days === best.days).length;
  const base = best.days === 0 ? 90 : best.days === 1 ? 85 : best.days <= 3 ? 80 : 70;
  const negated = own.amount.startsWith("-") ? own.amount.slice(1) : `-${own.amount}`;
  const reasons = [
    `Another account of yours has a line for exactly ${negated} (the opposite amount).`,
    best.days === 0 ? "Same date." : `${plural(best.days, "day")} apart.`,
  ];
  if (tied > 1) {
    reasons.push(
      `${tied - 1} other ${tied - 1 === 1 ? "line is" : "lines are"} equally near; check this is the right one.`,
    );
    return { itemId: best.candidate.itemId, confidence: Math.min(base, 50), reasons };
  }
  return { itemId: best.candidate.itemId, confidence: base, reasons };
}

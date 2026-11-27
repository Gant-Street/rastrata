import type { IngestItem, Proposal, ProposalContext, Proposer } from "../ingest-types.ts";
import { formatMoney, parseMoney } from "../money.ts";
import { tidyReasons } from "./engine.ts";
import { nameWords } from "./normalize.ts";

/** A small local classifier: naive Bayes over the identifying words of a bank memo, one class per
 * chart account, trained on the user's own posted history and decisions. Nothing leaves the
 * machine and no model is called at runtime; the whole thing is counting.
 *
 * Two questions are answered separately, because naive Bayes answers only the first well.
 *
 * 1. Which account? Naive Bayes ranks them:
 *
 *      score(account) = P(account) x P(direction | account) x product over known words of P(word | account)
 *
 *      P(account)             = (lines booked to it + 1) / (all lines + number of accounts)
 *      P(direction | account) = (its lines on this side + 1) / (its lines + 2)       money in or out
 *      P(word | account)      = (its lines containing the word + 1) / (its word total + vocabulary)
 *
 *    The "+ 1" and "+ 2" terms are Laplace (add-one) smoothing. A word the model has never seen is
 *    left out, not penalised. Scores are rescaled to add up to one. The account with the best score
 *    is the candidate, and it must lead the runner-up by `minMargin` points, so that a line whose
 *    words disagree is left alone.
 *
 * 2. Should it be suggested, and how sure? That is a question about track record, not about
 *    scores. Naive Bayes multiplies the words of a memo as if each were independent evidence, so
 *    its scores are not trustworthy as certainty: a merchant booked three ways (Amazon: supplies,
 *    equipment, groceries) can still score near 100% for the commonest way, while a spotless
 *    single-word merchant scores low because add-one smoothing is heavy over a large vocabulary.
 *    So the suggestion rests on the line's most reliable word: of the earlier lines containing it,
 *    what share went to the candidate (its agreement), and how many. It is suggested when that share
 *    is at least `minAgreement` on at least `minExamples` lines. The confidence shown is Laplace's
 *    own rule of succession for that record, (n + 1) / (N + 2): 3 of 3 lines reads 80%, 18 of 18
 *    reads 95%, 70 of 100 reads 70%. Few lines cannot read as certain.
 *
 * What the references teach, and what this does about it:
 * - GnuCash keeps one count per (word, account) and combines per-word probabilities, but it has no
 *   smoothing (a word seen once makes an account 100% likely), no class priors, a threshold fixed in
 *   code, and it splits memos on spaces only, so "AMZN Mktp US*2K4AB5" never matches next month's
 *   "AMZN Mktp US*9X1ZZ3". Here: smoothing, priors, thresholds that are configuration, a record
 *   behind every suggestion, and words normalised the same way rules.suggest does (normalize.ts).
 * - Direction is its own factor rather than a word. As a word in the multinomial it would favour
 *   accounts whose memos are short (the same word is a bigger share of fewer words); money in or out
 *   is a yes-or-no fact about a line and is counted that way.
 * - The evaluation harness (evaluate.ts) measures all of this on a book's own history. That, not
 *   any score, is what to trust.
 *
 * Words that name no merchant are not evidence. A bank file may write the account's own name into
 * every description (Rho puts "Willow Lane Studio Rho Checking" on each line), so every line has
 * "checking" and "rho". If everything booked so far went to one account, those words read as a
 * perfect record for it and a merchant never seen before would be suggested that account. So a word
 * written into most of an account's lines (`COMMON_SHARE`), or most of all the lines, is left out of
 * the score, of the record and of the count of words the model knows.
 *
 * Determinism: the same examples and the same line give the same answer on every runtime. Only
 * + - * / on doubles are used (correctly rounded everywhere): no logarithms, no exponentials. Accounts
 * and words are visited in code-unit order, so even rounding is repeatable. */

export type Direction = "in" | "out";

/** At most this many identifying words of one memo are used. */
export const WORD_LIMIT = 24;

/** Words that only say what kind of company or website it is. They appear under every account and
 * identify none, so they are left out of what the model learns and reads. */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "inc",
  "llc",
  "ltd",
  "corp",
  "co",
  "com",
  "net",
  "org",
  "www",
]);

/** The version of the way a prediction is made. It is part of the classifier's revision, so a change
 * to the method makes the Inbox suggest again for the lines still open, instead of leaving
 * suggestions made the old way on screen. */
export const CLASSIFIER_LOGIC = 2;

/** A word contained in at least this share (percent) of the lines is written into most of them, and
 * names no merchant: the account's own name on every row of a statement, a fixed label of a bank. */
export const COMMON_SHARE = 80;

/** "Most" needs a few lines to be said of. Below this many lines learned (from the line's own
 * account, and from all of them) every word is read, because a merchant seen on most of three lines
 * cannot be told from a label. A payer who makes up most of an account's lines is a job for a rule. */
export const COMMON_MIN_LINES = 5;

/** The words of a memo the classifier learns from and reads: its identifying words (numbers, dates
 * and reference ids dropped, see normalize.ts) without the generic ones. */
export function features(text: string): string[] {
  return nameWords(text)
    .filter((word) => !GENERIC_WORDS.has(word))
    .slice(0, WORD_LIMIT);
}

/** The text a bank line is learned from and classified by: who was paid, then the memo. */
export function lineText(line: { counterparty?: string; description: string }): string {
  return `${line.counterparty ?? ""} ${line.description}`;
}

/** One decision to learn from: this memo, on this side of the account, was booked to `accountId`. */
export interface TrainingExample {
  /** Stable identity (a journal or an inbox item), so the same decision is counted once. */
  readonly key: string;
  readonly accountId: string;
  /** The description, with the counterparty when there is one. */
  readonly text: string;
  readonly direction: Direction;
  /** YYYY-MM-DD, to learn in time order when evaluating. */
  readonly on: string;
  /** The bank or card account the line was on, when known. It lets the model tell what a statement
   * writes into every line of the account from what names a merchant. */
  readonly source?: string;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface Candidate {
  readonly accountId: string;
  /** The naive Bayes score, 0 to 1. It ranks accounts; it is not a probability of being right. */
  readonly score: number;
  /** Earlier lines booked to this account. */
  readonly examples: number;
}

/** How one word of a line has been booked in the past. */
export interface Evidence {
  readonly word: string;
  /** Earlier lines containing the word that went to the candidate account. */
  readonly inAccount: number;
  /** Earlier lines containing the word that went to any account that may be suggested. */
  readonly inAll: number;
}

export interface Prediction {
  /** Best first; at most `limit` of them. */
  readonly candidates: readonly Candidate[];
  /** Words of the line the model had seen in training. */
  readonly knownWords: number;
  /** The words that most favour the candidate over the runner-up, strongest first. */
  readonly evidence: readonly Evidence[];
  /** The line's most reliable word for the candidate (best smoothed record) and its agreement: the
   * share of earlier lines containing it that went to the candidate, `inAccount / inAll`. */
  readonly record: Evidence & { readonly agreement: number };
  /** Laplace's rule of succession for that record, (inAccount + 1) / (inAll + 2): the confidence
   * shown with a suggestion. */
  readonly confidence: number;
  /** `confidence` in whole percent, rounded down and never 100, computed with integers so that
   * 29 of 100 is 29 and not 28.999999999999996. */
  readonly confidencePercent: number;
}

export interface PredictOptions {
  /** Which accounts may be suggested (open, not the bank account itself). All when omitted. */
  readonly allowed?: (accountId: string) => boolean;
  readonly limit?: number;
  /** The bank or card account the line is on: words most of its lines share are not evidence. */
  readonly source?: string;
}

interface AccountCounts {
  /** Lines booked to the account. */
  docs: number;
  /** Of those, how many moved money in. */
  docsIn: number;
  /** Distinct words summed over its lines. */
  words: number;
}

export class ClassifierModel {
  readonly #accounts = new Map<string, AccountCounts>();
  /** For each word, the number of lines per account that contain it. */
  readonly #counts = new Map<string, Map<string, number>>();
  /** For each word, the number of lines containing it, whatever the account. */
  readonly #frequency = new Map<string, number>();
  /** For each bank or card account, its lines and how many of them contain each word. */
  readonly #sources = new Map<string, { lines: number; words: Map<string, number> }>();
  #total = 0;

  get examples(): number {
    return this.#total;
  }
  get vocabulary(): number {
    return this.#counts.size;
  }
  /** Lines per account, accounts in code-unit order. */
  accounts(): { accountId: string; examples: number }[] {
    return [...this.#accounts.entries()]
      .map(([accountId, counts]) => ({ accountId, examples: counts.docs }))
      .sort((a, b) => compare(a.accountId, b.accountId));
  }

  /** Learn one decision. `words` are the line's features; repeated words count once. `source` is
   * the bank or card account the line was on, when known. */
  add(accountId: string, words: readonly string[], direction: Direction, source?: string): void {
    const distinct = [...new Set(words)];
    let own = source === undefined ? undefined : this.#sources.get(source);
    if (source !== undefined && !own) {
      own = { lines: 0, words: new Map() };
      this.#sources.set(source, own);
    }
    if (own) own.lines++;
    let counts = this.#accounts.get(accountId);
    if (!counts) {
      counts = { docs: 0, docsIn: 0, words: 0 };
      this.#accounts.set(accountId, counts);
    }
    this.#total++;
    counts.docs++;
    if (direction === "in") counts.docsIn++;
    counts.words += distinct.length;
    for (const word of distinct) {
      let row = this.#counts.get(word);
      if (!row) {
        row = new Map();
        this.#counts.set(word, row);
      }
      row.set(accountId, (row.get(accountId) ?? 0) + 1);
      this.#frequency.set(word, (this.#frequency.get(word) ?? 0) + 1);
      if (own) own.words.set(word, (own.words.get(word) ?? 0) + 1);
    }
  }

  addExample(example: TrainingExample): void {
    this.add(example.accountId, features(example.text), example.direction, example.source);
  }

  /** Forget one decision learned with `add`, given the same account, words, direction and source: the
   * model afterwards is the one that never learned it (an account with no lines left and a word with no
   * line left are gone, as they would not exist had the decision never been learned). It lets a model be
   * moved from the examples it knows to the examples it should know by what differs, and not made again
   * from all of them. */
  remove(accountId: string, words: readonly string[], direction: Direction, source?: string): void {
    const distinct = [...new Set(words)];
    const own = source === undefined ? undefined : this.#sources.get(source);
    if (own && source !== undefined) {
      own.lines--;
      for (const word of distinct) {
        const left = (own.words.get(word) ?? 0) - 1;
        if (left > 0) own.words.set(word, left);
        else own.words.delete(word);
      }
      if (own.lines <= 0) this.#sources.delete(source);
    }
    const counts = this.#accounts.get(accountId);
    if (counts) {
      this.#total--;
      counts.docs--;
      if (direction === "in") counts.docsIn--;
      counts.words -= distinct.length;
      if (counts.docs <= 0) this.#accounts.delete(accountId);
    }
    for (const word of distinct) {
      const row = this.#counts.get(word);
      if (row) {
        const left = (row.get(accountId) ?? 0) - 1;
        if (left > 0) row.set(accountId, left);
        else row.delete(accountId);
        if (row.size === 0) this.#counts.delete(word);
      }
      const lines = (this.#frequency.get(word) ?? 0) - 1;
      if (lines > 0) this.#frequency.set(word, lines);
      else this.#frequency.delete(word);
    }
  }

  removeExample(example: TrainingExample): void {
    this.remove(example.accountId, features(example.text), example.direction, example.source);
  }

  /** Whether any word could carry a suggestion at all: one that has gone to some account on at least
   * `minExamples` lines and is not written into most of all the lines. A suggestion rests on the line's
   * most reliable word and needs that many lines behind it (`accept`), and a word every line shares is
   * not read (`#common`), so when no word qualifies the model suggests nothing for any line, however its
   * counts move. A word that is common to one bank account's lines and not to all qualifies here and
   * may still be left out for a line of that account: this says "could", never "does". */
  hasStrongWord(minExamples: number): boolean {
    const everyLine = this.#total >= COMMON_MIN_LINES;
    for (const [word, row] of this.#counts) {
      if (everyLine && (this.#frequency.get(word) ?? 0) * 100 >= COMMON_SHARE * this.#total)
        continue;
      for (const count of row.values()) if (count >= minExamples) return true;
    }
    return false;
  }

  /** What the model holds, as plain data in a fixed order, so that a test can compare two models. */
  snapshot(): unknown {
    const order = <T>(pairs: [string, T][]) =>
      pairs.sort(([left], [right]) => compare(left, right));
    return {
      total: this.#total,
      accounts: order([...this.#accounts].map(([id, counts]) => [id, { ...counts }])),
      counts: order(
        [...this.#counts].map(([word, row]) => [word, order([...row])] as [string, unknown]),
      ),
      frequency: order([...this.#frequency]),
      sources: order(
        [...this.#sources].map(
          ([id, own]) =>
            [id, { lines: own.lines, words: order([...own.words]) }] as [string, unknown],
        ),
      ),
    };
  }

  static from(examples: Iterable<TrainingExample>): ClassifierModel {
    const model = new ClassifierModel();
    for (const example of examples) model.addExample(example);
    return model;
  }

  /** Is the word written into most lines, so that it names no merchant? See `COMMON_SHARE`. Judged by
   * the lines of the line's own account when there are enough of them, and by all the lines. */
  #common(word: string, source: string | undefined): boolean {
    const own = source === undefined ? undefined : this.#sources.get(source);
    if (
      own &&
      own.lines >= COMMON_MIN_LINES &&
      (own.words.get(word) ?? 0) * 100 >= COMMON_SHARE * own.lines
    )
      return true;
    return (
      this.#total >= COMMON_MIN_LINES &&
      (this.#frequency.get(word) ?? 0) * 100 >= COMMON_SHARE * this.#total
    );
  }

  /** Rank the accounts for a line and find the record behind the best one. Null when the model has
   * nothing to go on: no eligible account, or none of the line's words were ever seen (words that
   * most lines share do not count as seen). Every allowed account competes, however few lines it
   * has; whether the candidate is believed is for `accept`. */
  predict(
    words: readonly string[],
    direction: Direction,
    options: PredictOptions = {},
  ): Prediction | null {
    const classes = [...this.#accounts.keys()]
      .filter((accountId) => (options.allowed ? options.allowed(accountId) : true))
      .sort(compare);
    if (classes.length === 0) return null;
    const known = [...new Set(words)]
      .filter((word) => this.#counts.has(word) && !this.#common(word, options.source))
      .sort(compare);
    if (known.length === 0) return null;
    const vocabulary = this.#counts.size;
    let documents = 0;
    for (const accountId of classes)
      documents += (this.#accounts.get(accountId) as AccountCounts).docs;
    const scores = classes.map((accountId) => {
      const counts = this.#accounts.get(accountId) as AccountCounts;
      const onThisSide = direction === "in" ? counts.docsIn : counts.docs - counts.docsIn;
      return (
        ((counts.docs + 1) / (documents + classes.length)) * ((onThisSide + 1) / (counts.docs + 2))
      );
    });
    const denominators = classes.map(
      (accountId) => (this.#accounts.get(accountId) as AccountCounts).words + vocabulary,
    );
    for (const word of known) {
      const row = this.#counts.get(word) as Map<string, number>;
      let sum = 0;
      for (const [index, accountId] of classes.entries()) {
        const next =
          (scores[index] as number) *
          (((row.get(accountId) ?? 0) + 1) / (denominators[index] as number));
        scores[index] = next;
        sum += next;
      }
      // Rescale each step so many small factors never underflow; the ratios are unchanged.
      for (let index = 0; index < scores.length; index++)
        scores[index] = (scores[index] as number) / sum;
    }
    const ranked = classes
      .map((accountId, index) => ({
        accountId,
        score: scores[index] as number,
        examples: (this.#accounts.get(accountId) as AccountCounts).docs,
        index,
      }))
      .sort((a, b) => b.score - a.score || compare(a.accountId, b.accountId));
    const best = ranked[0];
    const second = ranked[1];
    if (!best) return null;
    // How each known word has been booked: to the candidate, and to anything that may be suggested.
    const candidateDenominator = denominators[best.index] as number;
    const track = known.map((word) => {
      const row = this.#counts.get(word) as Map<string, number>;
      const inAccount = row.get(best.accountId) ?? 0;
      let inAll = 0;
      for (const accountId of classes) inAll += row.get(accountId) ?? 0;
      const ratio = second
        ? (inAccount + 1) /
          candidateDenominator /
          (((row.get(second.accountId) ?? 0) + 1) / (denominators[second.index] as number))
        : inAccount + 1;
      return { word, inAccount, inAll, ratio, smoothed: (inAccount + 1) / (inAll + 2) };
    });
    // The words that most favour the candidate over the runner-up: the visible reason.
    const evidence = track
      .filter((item) => item.inAccount > 0)
      .sort((a, b) => b.ratio - a.ratio || compare(a.word, b.word))
      .slice(0, 3)
      .map(({ word, inAccount, inAll }) => ({ word, inAccount, inAll }));
    // The most reliable word: best smoothed record, then more lines behind it, then alphabetical.
    const [reliable] = [...track].sort(
      (a, b) => b.smoothed - a.smoothed || b.inAll - a.inAll || compare(a.word, b.word),
    );
    if (!reliable) return null;
    return {
      candidates: ranked
        .slice(0, options.limit ?? 3)
        .map(({ accountId, score, examples }) => ({ accountId, score, examples })),
      knownWords: known.length,
      evidence,
      record: {
        word: reliable.word,
        inAccount: reliable.inAccount,
        inAll: reliable.inAll,
        agreement: reliable.inAll === 0 ? 0 : reliable.inAccount / reliable.inAll,
      },
      confidence: reliable.smoothed,
      confidencePercent: Math.min(
        99,
        Math.floor(((reliable.inAccount + 1) * 100) / (reliable.inAll + 2)),
      ),
    };
  }
}

/** Thresholds, all configuration. Percentages are whole numbers. */
export interface ClassifierConfig {
  readonly enabled: boolean;
  /** Of the earlier lines containing the line's most reliable word, at least this share (percent)
   * must have gone to the suggested account. */
  readonly minAgreement: number;
  /** The suggested account's naive Bayes score must lead the runner-up by at least this many points. */
  readonly minMargin: number;
  /** That word must have been booked to the suggested account on at least this many earlier lines. */
  readonly minExamples: number;
  /** The line must contain at least this many words the model has seen. */
  readonly minKnownWords: number;
}

/** The defaults come from the evaluation harness (see the lane doc): they suggest for about three
 * lines in four on the synthetic fixture and are right about 97 to 99 times in a hundred. The
 * margin only rules out a near tie between two accounts; raising it costs recall for no gain. */
export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  enabled: true,
  minAgreement: 90,
  minMargin: 10,
  minExamples: 3,
  minKnownWords: 1,
};

export const CONFIG_LIMITS = {
  minAgreement: { min: 50, max: 100 },
  minMargin: { min: 0, max: 99 },
  minExamples: { min: 1, max: 100 },
  minKnownWords: { min: 1, max: 5 },
} as const;

/** Does this prediction clear the configured thresholds? The candidate, or null. `shown` also
 * requires the confidence displayed with the suggestion to be at least that many percent. */
export function accept(
  prediction: Prediction | null,
  config: ClassifierConfig,
  shown = 0,
): Candidate | null {
  if (!prediction) return null;
  const best = prediction.candidates[0];
  if (!best || prediction.knownWords < config.minKnownWords) return null;
  const { inAccount, inAll } = prediction.record;
  if (inAccount < config.minExamples) return null;
  // Integer arithmetic: 9 of 10 is exactly 90%, whatever a double makes of 0.9.
  if (inAccount * 100 < config.minAgreement * inAll) return null;
  const margin = best.score - (prediction.candidates[1]?.score ?? 0);
  if (Math.floor(margin * 100) < config.minMargin) return null;
  return prediction.confidencePercent >= shown ? best : null;
}

/** Human-readable reasons for a suggestion: what it resembles, the record it rests on, how sure it
 * is. Names accounts through `label`. */
export function reasonsFor(
  prediction: Prediction,
  best: Candidate,
  label: (accountId: string) => string,
): string[] {
  const lines = (count: number) => `${count} ${count === 1 ? "line" : "lines"}`;
  const record = prediction.record;
  const others = prediction.evidence.filter((item) => item.word !== record.word);
  const reasons = [
    `Resembles the ${lines(best.examples)} you booked to ${label(best.accountId)} before.`,
    `“${record.word}” went to ${label(best.accountId)} on ${record.inAccount} of the ${lines(record.inAll)} that contain it.`,
  ];
  if (others.length > 0)
    reasons.push(
      `Other words that point here: ${others.map((item) => `${item.word} (${item.inAccount} of ${item.inAll})`).join(", ")}.`,
    );
  const next = prediction.candidates[1];
  reasons.push(
    `Confidence ${prediction.confidencePercent}%, smoothed so that a few lines cannot read as certain.${next ? ` Next best: ${label(next.accountId)}.` : ""} A score orders suggestions; it is not a promise.`,
  );
  return tidyReasons(reasons);
}

/** The classifier as a proposer, for a snapshot of the trained model and its configuration. Build
 * it once per proposing run. It suggests one categorisation, with the bank leg, never posts, and
 * stays silent when it has not seen enough or is not clear enough. */
export function createClassifierProposer(
  model: ClassifierModel,
  config: ClassifierConfig,
): Proposer {
  const charts = new WeakMap<ProposalContext, Map<string, ProposalContext["accounts"][number]>>();
  const chartOf = (context: ProposalContext) => {
    const known = charts.get(context);
    if (known) return known;
    const made = new Map(context.accounts.map((account) => [account.id, account]));
    charts.set(context, made);
    return made;
  };
  return {
    name: "classifier",
    propose(item: IngestItem, context: ProposalContext): readonly Proposal[] {
      if (!config.enabled) return [];
      if (item.line.kind !== "bankLine") return [];
      if (item.status !== "new" && item.status !== "proposed") return [];
      const bankId = item.ledgerAccountId;
      if (bankId === null) return [];
      let cents: bigint;
      try {
        cents = parseMoney(item.line.amount);
      } catch {
        return [];
      }
      if (cents === 0n) return [];
      const chart = chartOf(context);
      const prediction = model.predict(features(lineText(item.line)), cents > 0n ? "in" : "out", {
        allowed: (accountId) => {
          const account = chart.get(accountId);
          return account !== undefined && account.closedOn === null && accountId !== bankId;
        },
        limit: 2,
        source: bankId,
      });
      const best = accept(prediction, config);
      if (!prediction || !best) return [];
      const label = (accountId: string): string => {
        const account = chart.get(accountId);
        return account ? `${account.code} ${account.name}` : accountId;
      };
      const size = cents < 0n ? -cents : cents;
      return [
        {
          proposer: "classifier",
          kind: "categorize",
          confidence: prediction.confidencePercent / 100,
          reasons: reasonsFor(prediction, best, label),
          legs: [
            { accountId: bankId, amount: formatMoney(cents) },
            { accountId: best.accountId, amount: formatMoney(cents > 0n ? -size : size) },
          ],
        },
      ];
    },
  };
}

import {
  accept,
  ClassifierModel,
  type ClassifierConfig,
  features,
  type Prediction,
  type TrainingExample,
} from "./classifier.ts";

/** How good is the classifier on a book's own history? The harness replays the examples in time
 * order, the way the book actually grew: before each line is scored the model has learned only from
 * the lines before it, then it learns that line too (the "test, then train" or prequential
 * method). Nothing is held back or peeked at, and a line is never used to predict itself.
 *
 * Precision is the fraction of suggestions that were right; recall is the fraction of all lines
 * that received a right suggestion. Both are reported as exact counts, with basis points computed
 * by integer division, so the same history always gives the same report. */

export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  /** Hundredths of a percent, rounded down (9350 is 93.50%); null when the denominator is zero. */
  readonly basisPoints: number | null;
}

const ratio = (numerator: number, denominator: number): Ratio => ({
  numerator,
  denominator,
  basisPoints: denominator === 0 ? null : Math.floor((numerator * 10000) / denominator),
});

/** What would have happened had only suggestions at or above a displayed confidence been trusted
 * (the way a bulk accept in the Inbox would choose them). The agreement, margin and example
 * thresholds are kept. */
export interface ThresholdRow {
  /** The confidence shown with a suggestion, in whole percent. */
  readonly minConfidence: number;
  readonly proposed: number;
  readonly correct: number;
  readonly precision: Ratio;
  readonly recall: Ratio;
}

/** One account's own report. Precision is over the suggestions made for the account (how often
 * "book it to Software" was right); recall is over the lines that truly belong to it (how many of
 * Software's lines were found). The two share a numerator: suggestions for it that were right. */
export interface AccountRow {
  readonly accountId: string;
  /** Scored lines that truly belong to this account. */
  readonly scored: number;
  /** Suggestions made for this account, right or wrong. */
  readonly proposed: number;
  /** Suggestions for this account that were right. */
  readonly correct: number;
  readonly precision: Ratio;
  readonly recall: Ratio;
}

export interface Confusion {
  readonly actual: string;
  readonly predicted: string;
  readonly count: number;
}

export interface EvaluationReport {
  readonly examples: number;
  /** Lines learned from but not scored, so early lines with nothing to go on do not drag it down. */
  readonly warmup: number;
  readonly scored: number;
  readonly proposed: number;
  readonly correct: number;
  readonly precision: Ratio;
  readonly recall: Ratio;
  /** The fraction of scored lines that got any suggestion. */
  readonly coverage: Ratio;
  /** The same counts if only suggestions at or above each displayed confidence were trusted. */
  readonly thresholds: readonly ThresholdRow[];
  readonly accounts: readonly AccountRow[];
  /** The most common wrong suggestions, most frequent first. */
  readonly confusions: readonly Confusion[];
}

export interface EvaluationOptions {
  readonly config: ClassifierConfig;
  /** Lines to learn from before scoring starts; defaults to a quarter of the examples. */
  readonly warmup?: number;
}

const SWEEP = [50, 60, 70, 80, 85, 90, 95, 99];
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Outcome {
  readonly actual: string;
  readonly prediction: Prediction | null;
}

export function evaluate(
  examples: readonly TrainingExample[],
  options: EvaluationOptions,
): EvaluationReport {
  const ordered = [...examples].sort((a, b) => compare(a.on, b.on) || compare(a.key, b.key));
  const warmup = Math.max(
    0,
    Math.min(ordered.length, options.warmup ?? Math.floor(ordered.length / 4)),
  );
  const model = new ClassifierModel();
  const outcomes: Outcome[] = [];
  for (const [index, example] of ordered.entries()) {
    const words = features(example.text);
    if (index >= warmup)
      outcomes.push({
        actual: example.accountId,
        prediction: model.predict(words, example.direction, {
          limit: 2,
          ...(example.source !== undefined ? { source: example.source } : {}),
        }),
      });
    model.add(example.accountId, words, example.direction, example.source);
  }
  const tally = (config: ClassifierConfig, shown = 0) => {
    let proposed = 0;
    let correct = 0;
    const perAccount = new Map<string, { scored: number; proposed: number; correct: number }>();
    const rowOf = (accountId: string) => {
      let row = perAccount.get(accountId);
      if (!row) {
        row = { scored: 0, proposed: 0, correct: 0 };
        perAccount.set(accountId, row);
      }
      return row;
    };
    const wrong = new Map<string, number>();
    for (const outcome of outcomes) {
      rowOf(outcome.actual).scored++;
      const best = accept(outcome.prediction, config, shown);
      if (!best) continue;
      proposed++;
      rowOf(best.accountId).proposed++;
      if (best.accountId === outcome.actual) {
        correct++;
        rowOf(best.accountId).correct++;
      } else {
        const key = JSON.stringify([outcome.actual, best.accountId]);
        wrong.set(key, (wrong.get(key) ?? 0) + 1);
      }
    }
    return { proposed, correct, perAccount, wrong };
  };
  const base = tally(options.config);
  const scored = outcomes.length;
  return {
    examples: ordered.length,
    warmup,
    scored,
    proposed: base.proposed,
    correct: base.correct,
    precision: ratio(base.correct, base.proposed),
    recall: ratio(base.correct, scored),
    coverage: ratio(base.proposed, scored),
    thresholds: SWEEP.map((minConfidence) => {
      const row = tally(options.config, minConfidence);
      return {
        minConfidence,
        proposed: row.proposed,
        correct: row.correct,
        precision: ratio(row.correct, row.proposed),
        recall: ratio(row.correct, scored),
      };
    }),
    accounts: [...base.perAccount.entries()]
      .sort(
        (a, b) => b[1].scored - a[1].scored || b[1].proposed - a[1].proposed || compare(a[0], b[0]),
      )
      .map(([accountId, row]) => ({
        accountId,
        scored: row.scored,
        proposed: row.proposed,
        correct: row.correct,
        precision: ratio(row.correct, row.proposed),
        recall: ratio(row.correct, row.scored),
      })),
    confusions: [...base.wrong.entries()]
      .map(([key, count]) => {
        const [actual = "", predicted = ""] = JSON.parse(key) as string[];
        return { actual, predicted, count };
      })
      .sort(
        (a, b) =>
          b.count - a.count || compare(a.actual, b.actual) || compare(a.predicted, b.predicted),
      )
      .slice(0, 10),
  };
}

import type { ClassifierConfig, ClassifierModel, TrainingExample } from "../../rules/classifier.ts";
import { evaluate, type EvaluationReport } from "../../rules/evaluate.ts";
import { exampleFromDecision, exampleFromLine } from "../../rules/history.ts";
import type { MerchantHistory } from "../../rules/starter/proposer.ts";
import type { ApplicationService } from "../../service.ts";
import { draftedDecisions, invalidateProposals } from "../ingest/read.ts";
import { readLedgerView, sourceDescriptions } from "./history.ts";
import { readDecisions } from "./inbox.ts";
import { advance, forgetLearner, isDecisionKey, learned, learnerOf, take } from "./learning.ts";
import { postedLinesFor } from "./lines.ts";
import {
  readConfig,
  readExamples,
  readTraining,
  rulesState,
  type StoredEvaluation,
  syncExamples,
  type TrainingState,
  writeConfig,
  writeTraining,
} from "./store.ts";

/** The classifier's operations: where its examples come from, how its model is held, and the
 * status, training, configuration and evaluation the screens and the CLI show.
 *
 * The model is derived data. It is made from the examples table, held in memory per service, and moved
 * on in place by what changed in the book (`learning.ts`); it is made again from the table only when
 * `modelVersion` moves under it. */

export function loadModel(service: ApplicationService): ClassifierModel {
  return learnerOf(service).model;
}

/** How the merchants the starter list knows were booked, from the examples the classifier knows. */
export function loadHistory(service: ApplicationService): MerchantHistory {
  return learnerOf(service).history;
}

function ratioWire(ratio: EvaluationReport["precision"]): Record<string, unknown> {
  return {
    numerator: ratio.numerator,
    denominator: ratio.denominator,
    basisPoints: ratio.basisPoints,
  };
}

function method(report: EvaluationReport): string {
  if (report.examples === 0)
    return "There is no history to replay yet. It is measured once lines have been posted.";
  return `Replays ${report.examples} posted decision${report.examples === 1 ? "" : "s"} in date order. Each line is scored by a classifier that has learned only from the lines before it, and then it learns that line too. The first ${report.warmup} line${report.warmup === 1 ? " is" : "s are"} learned from but not scored, so the earliest lines, with nothing to go on, do not drag the numbers down. Counts are exact; the percentages are rounded down.`;
}

export function evaluationWire(stored: StoredEvaluation): Record<string, unknown> {
  const report = stored.report;
  return {
    config: { ...stored.config },
    examples: report.examples,
    warmup: report.warmup,
    scored: report.scored,
    proposed: report.proposed,
    correct: report.correct,
    precision: ratioWire(report.precision),
    recall: ratioWire(report.recall),
    coverage: ratioWire(report.coverage),
    thresholds: report.thresholds.map((row) => ({
      minConfidence: row.minConfidence,
      proposed: row.proposed,
      correct: row.correct,
      precision: ratioWire(row.precision),
      recall: ratioWire(row.recall),
    })),
    accounts: report.accounts.map((row) => ({
      accountId: row.accountId,
      scored: row.scored,
      proposed: row.proposed,
      correct: row.correct,
      precision: ratioWire(row.precision),
      recall: ratioWire(row.recall),
    })),
    confusions: report.confusions.map((row) => ({ ...row })),
    method: method(report),
    computedAt: stored.computedAt,
  };
}

/** The book revision today, to tell whether training has gone stale. */
async function currentRevision(service: ApplicationService): Promise<string> {
  return (await service.ledgerHead()).bookRevision;
}

/** The classifier as the status card and `classifier.status` show it. `head` is the book revision
 * today. Synchronous, so a retained write can return it as its first response. */
function statusAt(service: ApplicationService, head: string): Record<string, unknown> {
  const store = service.store;
  const config = readConfig(store);
  const training = readTraining(store);
  const model = loadModel(service);
  const evaluated = measured(service, training, config);
  const accounts = model.accounts();
  const ready = accounts.some((account) => account.examples >= config.minExamples);
  const notes: string[] = [];
  if (!config.enabled) notes.push("The classifier is switched off, so it proposes nothing.");
  if (model.examples === 0)
    notes.push(
      training.trainedAt
        ? "The last training found no posted lines to learn from."
        : "It learns from the transactions you post and the choices you make in review, and learns again on its own as they arrive.",
    );
  else if (!ready)
    notes.push(
      `No account has ${config.minExamples} earlier transactions yet, so it suggests nothing until one does.`,
    );
  if (training.heldBack > 0)
    notes.push(
      `It has ${training.heldBack} transactions to learn from, more than it learns from on its own at once. Train it to learn from all of them.`,
    );
  else if (training.trainedThroughRevision !== null && behind(service, head))
    notes.push(
      "The books have changed since it last learned. It learns again when new transactions arrive for review, or when it is trained now.",
    );
  return {
    config: { ...config },
    ready: ready && config.enabled,
    examples: model.examples,
    accounts: accounts.length,
    vocabulary: model.vocabulary,
    topAccounts: [...accounts]
      .sort((a, b) => b.examples - a.examples || (a.accountId < b.accountId ? -1 : 1))
      .slice(0, 20),
    sources: { ...training.sources },
    modelVersion: training.modelVersion,
    trainedAt: training.trainedAt,
    trainedThroughRevision: training.trainedThroughRevision,
    evaluation: evaluated ? evaluationWire(evaluated) : null,
    heldBack: training.heldBack,
    notes,
  };
}

/** The measurement of the history the classifier learned from, for the thresholds in force: the one a
 * training on request made when there is one, else made now from the examples it knows and kept until they
 * or the thresholds change. The classifier learning by itself does not measure at each learning (that
 * replays the whole history, and learning waits on the Inbox's reading); the card that shows the figures
 * is what asks. Null when it has never learned. */
function measured(
  service: ApplicationService,
  training: TrainingState,
  config: ClassifierConfig,
): StoredEvaluation | null {
  if (training.evaluation) return training.evaluation;
  if (training.trainedAt === null) return null;
  const learner = learnerOf(service);
  const key = `${training.modelVersion}:${JSON.stringify(config)}`;
  if (learner.evaluation?.key !== key) {
    const examples = [...learner.stored.values()].sort(
      (a, b) =>
        (a.on < b.on ? -1 : a.on > b.on ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    learner.evaluation = { key, report: evaluate(examples, { config }) };
  }
  return { config, report: learner.evaluation.report, computedAt: training.trainedAt };
}

export async function status(service: ApplicationService): Promise<Record<string, unknown>> {
  return statusAt(service, await currentRevision(service));
}

/** What the classifier learns from. Posted journals are the ledger's own record of a decision. A
 * line that came through the Inbox is read the way the Inbox shows it (counterparty and memo)
 * rather than from the journal's source description, so training and suggesting read a line the
 * same way; lines decided but not yet posted add what a person has chosen since the last posting. */
export async function gatherExamples(service: ApplicationService): Promise<{
  examples: TrainingExample[];
  posted: number;
  decisions: number;
  bookRevision: string;
}> {
  const ledger = await readLedgerView(service);
  const decided = readDecisions(service);
  const byJournal = new Map(
    decided.flatMap((item) => (item.journalId ? [[item.journalId, item] as const] : [])),
  );
  const examples: TrainingExample[] = [];
  for (const line of ledger.lines) {
    const example = exampleFromLine(line);
    const inbox = byJournal.get(line.journalId);
    const fromInbox = inbox ? exampleFromDecision(inbox) : null;
    examples.push(fromInbox ? { ...example, text: fromInbox.text } : example);
  }
  let decisions = 0;
  for (const item of decided) {
    if (item.journalId) continue;
    const example = exampleFromDecision(item);
    if (!example) continue;
    examples.push(example);
    decisions++;
  }
  return { examples, posted: ledger.lines.length, decisions, bookRevision: ledger.bookRevision };
}

/** How many decided lines are not yet posted, to tell whether training has gone stale. Only a line that is
 * drafted can be decided and not posted, so these are all that is read. */
function draftDecisions(service: ApplicationService): number {
  let count = 0;
  for (const item of draftedDecisions(service)) if (exampleFromDecision(item) !== null) count++;
  return count;
}

/** Whether the book or the Inbox's decisions have moved on since the classifier last learned. */
export function behind(service: ApplicationService, head: string): boolean {
  const training = readTraining(service.store);
  return (
    training.trainedThroughRevision !== head ||
    draftDecisions(service) !== training.sources.decisions
  );
}

/** A decision made in For review that the classifier has not learned from: its example is not in the
 * table. A decision that was posted since is not new (its example is there under its decision key, and
 * the posted line says the same). */
function newDecisions(service: ApplicationService): boolean {
  const stored = learnerOf(service).stored;
  for (const item of draftedDecisions(service)) {
    const example = exampleFromDecision(item);
    if (example && !stored.has(example.key)) return true;
  }
  return false;
}

/** Everything a training on request computes before anything is written: the examples, made from the whole
 * book, and the measurement replayed over them. Reading the ledger and replaying happen outside any write,
 * so the book is never locked while they run. */
interface PreparedTraining {
  readonly examples: TrainingExample[];
  readonly posted: number;
  readonly decisions: number;
  readonly bookRevision: string;
  readonly config: ClassifierConfig;
  readonly report: EvaluationReport;
}

async function prepareTraining(service: ApplicationService): Promise<PreparedTraining> {
  const { examples, posted, decisions, bookRevision } = await gatherExamples(service);
  const config = readConfig(service.store);
  const report = evaluate(examples, { config });
  return { examples, posted, decisions, bookRevision, config, report };
}

/** Keep what a training on request computed: the examples the model is built from and the record of the
 * training. The model's version moves only when the examples changed (or this is the first training), so
 * unchanged history is not new learning. What the proposers suggest may have changed with the examples, so
 * every open line is proposed again; a training on request is not a thing that happens at every reading. */
function recordTraining(service: ApplicationService, prepared: PreparedTraining): void {
  const state = rulesState(service);
  const prior = readTraining(service.store);
  const { written } = syncExamples(service.store, prepared.examples);
  const now = state.now();
  const next: TrainingState = {
    modelVersion:
      written > 0 || prior.trainedAt === null ? prior.modelVersion + 1 : prior.modelVersion,
    trainedAt: now,
    trainedThroughRevision: prepared.bookRevision,
    // Where the examples stand in the book is not known to a training made from the whole of it, so the next
    // learning on its own reads the whole of it once more.
    through: null,
    sources: { posted: prepared.posted, decisions: prepared.decisions },
    evaluation: { config: prepared.config, report: prepared.report, computedAt: now },
    heldBack: 0,
    heldBackRevision: null,
  };
  writeTraining(service.store, next);
  if (written > 0) invalidateProposals(service);
  forgetLearner(service);
}

/** Learn from the book's posted history and the Inbox's decisions again, and re-measure: the
 * operation an agent calls (`rastrata classifier train`), and the one button the Rules page shows
 * when a history is too long to learn from on the side, retained under its identity. */
export async function train(
  service: ApplicationService,
  operationId: string,
): Promise<Record<string, unknown>> {
  rulesState(service);
  const head = await currentRevision(service);
  const prepared = await prepareTraining(service);
  return service.retainRequest(operationId, "classifier.train", {}, () => {
    recordTraining(service, prepared);
    return statusAt(service, head);
  });
}

/** The most example rows a learning on the classifier's own account writes at once. A longer
 * history is learned from when someone trains it: a hosted book's request is one log entry of
 * bounded size, and the Inbox's own read must never be refused for a learning it did on the side. */
export const autoLearn = { maxRows: 5000 };

/** Learn again on the service's own account when there is something new to learn from. The Inbox
 * calls this at the start of a run begun by a reader of For review, so the suggestions the reader is
 * about to see reflect the book and the decisions as they are now: it learns when it never has, when
 * a line was decided in For review since (a merchant categorised once is suggested for its next
 * line), and when the books moved on since (a posted batch is learned from before the next statement
 * is reviewed). A run of changes (accepting, posting) does not learn on each call; the next reader
 * does, once. Nothing is written when the classifier is switched off, when there is nothing at all to
 * learn from yet (the status keeps saying so), or when the learning would write more than it may at
 * once. True when it learned. */
export async function learnIfBehind(service: ApplicationService): Promise<boolean> {
  rulesState(service);
  const store = service.store;
  if (!readConfig(store).enabled) return false;
  const head = await currentRevision(service);
  const first = readTraining(store);
  if (first.trainedThroughRevision !== null && !behind(service, head)) return false;
  // A long history it held back from is not worked out again until the book or the decisions move.
  if (first.heldBack > 0 && first.heldBackRevision === head && !newDecisions(service)) return false;
  // The book is read once, and from here to the end there is nothing to wait for: what the examples should
  // be, what to write and what it changes for the proposers are worked out in one stretch, so that nothing
  // else that learns or trains can come between them.
  const { aggregate } = await service.readAggregate();
  const state = aggregate.state;
  const training = readTraining(store);
  const config = readConfig(store);
  if (!config.enabled) return false;
  const lines = postedLinesFor(state, sourceDescriptions(service));
  const learner = learnerOf(service);
  const through = advance(service, learner, state, lines);
  if (training.trainedAt === null) {
    // Nothing to learn from yet, and nothing learned: the status keeps saying so.
    let known = learner.stored.size;
    for (const [key, example] of learner.pending) {
      const held = learner.stored.has(key);
      if (example === null) known -= held ? 1 : 0;
      else if (!held) known += 1;
    }
    if (known === 0) return false;
  }
  const rows = learner.pending.size;
  if (rows > autoLearn.maxRows) {
    if (training.heldBack !== rows || training.heldBackRevision !== head)
      writeTraining(store, { ...training, heldBack: rows, heldBackRevision: head });
    return false;
  }
  const changes = [...learner.pending];
  const effect = take(learner, config.minExamples, config.enabled);
  const now = rulesState(service).now();
  const next: TrainingState = {
    modelVersion: changes.length > 0 ? training.modelVersion + 1 : training.modelVersion,
    trainedAt: now,
    trainedThroughRevision: state.bookRevision.toString(),
    through,
    sources: { posted: lines.size, decisions: learner.decisions },
    // The figures for what it learned are made when the card that shows them is read; unchanged examples
    // are the figures they were.
    evaluation:
      changes.length === 0 && training.evaluation
        ? { ...training.evaluation, computedAt: now }
        : null,
    heldBack: 0,
    heldBackRevision: null,
  };
  try {
    store.transaction(() => {
      const insert = store.query(
        "INSERT OR REPLACE INTO rules_example (key, account_id, text, direction, on_date, origin, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const remove = store.query("DELETE FROM rules_example WHERE key=?");
      for (const [key, example] of changes)
        if (example === null) remove.run(key);
        else
          insert.run(
            key,
            example.accountId,
            example.text,
            example.direction,
            example.on,
            isDecisionKey(key) ? "decision" : "journal",
            example.source ?? null,
          );
      // The lines waiting are proposed again only when what the proposers read could have changed.
      if (changes.length > 0 && (effect.classifier || effect.starter)) {
        learned.invalidated += 1;
        invalidateProposals(service);
      } else if (changes.length > 0) learned.kept += 1;
      writeTraining(store, next);
    });
  } catch (error) {
    // What is held moved on and the table did not: make it again from the table.
    forgetLearner(service);
    throw error;
  }
  learner.version = next.modelVersion;
  return true;
}

type ConfigChange = Partial<ClassifierConfig>;

function applyChange(base: ClassifierConfig, change: ConfigChange): ClassifierConfig {
  return {
    enabled: change.enabled ?? base.enabled,
    minAgreement: change.minAgreement ?? base.minAgreement,
    minMargin: change.minMargin ?? base.minMargin,
    minExamples: change.minExamples ?? base.minExamples,
    minKnownWords: change.minKnownWords ?? base.minKnownWords,
  };
}

export async function configure(
  service: ApplicationService,
  operationId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const head = await currentRevision(service);
  const state = rulesState(service);
  return service.retainRequest(operationId, "classifier.configure", input, () => {
    const config = applyChange(readConfig(service.store), input as ConfigChange);
    writeConfig(service.store, config);
    // The measured numbers belong to the thresholds they were measured with. Measure again, from
    // the same examples, so the card never shows figures for settings that are no longer in force.
    const training = readTraining(service.store);
    if (training.evaluation)
      writeTraining(service.store, {
        ...training,
        evaluation: {
          config,
          report: evaluate(readExamples(service.store), { config }),
          computedAt: state.now(),
        },
      });
    return statusAt(service, head);
  });
}

/** Measure the classifier on the examples it was last trained on, with the thresholds stored or
 * the ones supplied. Changes nothing. */
export function evaluateNow(
  service: ApplicationService,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const state = rulesState(service);
  const config = applyChange(readConfig(service.store), (input.config ?? {}) as ConfigChange);
  const examples = readExamples(service.store);
  return evaluationWire({
    config,
    report: evaluate(examples, { config }),
    computedAt: state.now(),
  });
}

/** What the classifier knows, kept current from what changed instead of worked out again from the whole book.
 *
 * The classifier learns from the book's own record: its posted entries, read as past bank lines, and the
 * decisions made in the Inbox that are not posted yet. That is a set of examples, kept in `rules_example`.
 * Learning again used to read every entry of the book, rebuild every example, measure the whole history and
 * compare it with the table, at the first reading after anything changed; its cost grew with the book, and
 * so did everything that waited for it. This holds the examples as they are stored, the model and the
 * starter's history built from them, and what differs between them and what the book now says
 * (`pending`), and moves all of it on by what changed: the entries the ledger's new revisions added or took
 * out, and the lines the Inbox's log says were decided, posted or taken back.
 *
 * The examples that ought to be there are those `gatherExamples` makes from the whole book (it stays, as the
 * reference and for training on request), and this must give exactly them; `test/rules-learning.test.ts`
 * holds it to that after every step of random histories.
 *
 * An example comes from one of two places, and has a key that says which: `journal:<id>` for an entry in
 * effect that reads as a decision (its text is the Inbox's reading of the line when a line was posted as it,
 * else the entry's own), and `decision:<line id>` for a line decided and not posted. When a change touches a
 * line or an entry, the examples under its keys are worked out again and set against what is stored. */
import type { BookState } from "@rastrata/kernel";
import { deltaOf, positionOf, revisionsAfter } from "../../reports/ledger-history.ts";
import { ClassifierModel, type TrainingExample } from "../../rules/classifier.ts";
import type { EvaluationReport } from "../../rules/evaluate.ts";
import { exampleFromDecision, exampleFromLine } from "../../rules/history.ts";
import { MerchantHistory } from "../../rules/starter/proposer.ts";
import type { ApplicationService } from "../../service.ts";
import {
  changesSince,
  decidedItem,
  decidedItemFor,
  decidedItems,
  itemJournal,
} from "../ingest/read.ts";
import { sliceState } from "../state.ts";
import type { PostedLines } from "./lines.ts";
import { type Through, readExamples, readTraining } from "./store.ts";

export interface Learner {
  /** The examples as the table holds them. */
  readonly stored: Map<string, TrainingExample>;
  /** The model made from them. */
  readonly model: ClassifierModel;
  /** How the merchants the starter list knows were booked, from them. */
  readonly history: MerchantHistory;
  /** How many of the stored examples are decisions (their key starts `decision:`). */
  decisions: number;
  /** The `modelVersion` this stands for: when the table is on another, it is made again from the table. */
  version: number;
  /** Where the book says an example differs from what is stored: the example it should be, or null for an
   * example that should not be there. Only keys that differ are held. */
  readonly pending: Map<string, TrainingExample | null>;
  /** What `pending` is worked out through; null when nothing has been, so the first reading is of the whole
   * book. */
  through: Through | null;
  /** The lines `pending` was worked out with: lines made again from the book are not a continuation. */
  lines: PostedLines | null;
  /** The measurement of the stored examples, for the thresholds it was made with, so that the card that
   * shows it does not measure the history again each time it is read. */
  evaluation: { readonly key: string; readonly report: EvaluationReport } | null;
}

export const isDecisionKey = (key: string): boolean => key.startsWith("decision:");

/** How learning went in this process, which a test reads to say that it was not vacuous: the learnings that
 * changed the examples and marked the open lines for proposing again, and those that changed them and left
 * the lines alone because nothing the proposers read could have changed. It carries no accounting meaning. */
export const learned = { invalidated: 0, kept: 0 };

const same = (a: TrainingExample, b: TrainingExample): boolean =>
  a.accountId === b.accountId &&
  a.text === b.text &&
  a.direction === b.direction &&
  a.on === b.on &&
  (a.source ?? null) === (b.source ?? null);

function made(service: ApplicationService, version: number): Learner {
  const training = readTraining(service.store);
  const stored = new Map<string, TrainingExample>();
  const model = new ClassifierModel();
  const history = new MerchantHistory();
  let decisions = 0;
  for (const example of readExamples(service.store)) {
    stored.set(example.key, example);
    model.addExample(example);
    history.add(example);
    if (isDecisionKey(example.key)) decisions += 1;
  }
  return {
    stored,
    model,
    history,
    decisions,
    version,
    pending: new Map(),
    through: training.through,
    lines: null,
    evaluation: null,
  };
}

/** What the classifier knows in this service, made from the table of examples the first time and when the
 * table has moved to another model version under it (another service trained it). */
export function learnerOf(service: ApplicationService): Learner {
  const cache = sliceState(service, "rules.learning", () => ({ current: null as Learner | null }));
  const version = readTraining(service.store).modelVersion;
  if (cache.current === null || cache.current.version !== version)
    cache.current = made(service, version);
  return cache.current;
}

/** Forget what is held, so that it is made again from the table: after a training that wrote the table
 * itself, or a write that did not complete. */
export function forgetLearner(service: ApplicationService): void {
  const cache = sliceState(service, "rules.learning", () => ({ current: null as Learner | null }));
  cache.current = null;
}

/** The example an entry gives, or null: its line, in the Inbox's reading when a line was posted as it. */
function ofJournal(
  service: ApplicationService,
  lines: PostedLines,
  journalId: string,
): TrainingExample | null {
  const line = lines.get(journalId);
  if (!line) return null;
  const example = exampleFromLine(line);
  const decided = decidedItemFor(service, journalId);
  const fromInbox = decided ? exampleFromDecision(decided) : null;
  return fromInbox ? { ...example, text: fromInbox.text } : example;
}

/** The example a decided line gives, or null: only a line that is not posted is learned from as a decision. */
function ofDecision(service: ApplicationService, itemId: string): TrainingExample | null {
  const decided = decidedItem(service, itemId);
  if (!decided || decided.journalId) return null;
  return exampleFromDecision(decided);
}

/** Work out what `pending` should be from the whole book: every example it makes, set against the table. */
function everything(service: ApplicationService, learner: Learner, lines: PostedLines): void {
  const decided = decidedItems(service);
  const byJournal = new Map(
    decided.flatMap((item) => (item.journalId ? [[item.journalId, item] as const] : [])),
  );
  const target = new Map<string, TrainingExample>();
  for (const line of lines.sorted()) {
    const example = exampleFromLine(line);
    const inbox = byJournal.get(line.journalId);
    const fromInbox = inbox ? exampleFromDecision(inbox) : null;
    target.set(example.key, fromInbox ? { ...example, text: fromInbox.text } : example);
  }
  for (const item of decided) {
    if (item.journalId) continue;
    const example = exampleFromDecision(item);
    if (example) target.set(example.key, example);
  }
  learner.pending.clear();
  for (const [key, example] of target) {
    const held = learner.stored.get(key);
    if (held === undefined || !same(held, example)) learner.pending.set(key, example);
  }
  for (const key of learner.stored.keys()) if (!target.has(key)) learner.pending.set(key, null);
}

/** Set one key against the table: it differs or it does not. */
function retarget(learner: Learner, key: string, example: TrainingExample | null): void {
  const held = learner.stored.get(key);
  if (example === null) {
    if (held === undefined) learner.pending.delete(key);
    else learner.pending.set(key, null);
  } else if (held !== undefined && same(held, example)) learner.pending.delete(key);
  else learner.pending.set(key, example);
}

/** Bring `pending` to what the book says at this state: for what changed since it was last worked out, the
 * examples under the keys of the entries the ledger's revisions added or took out, and of the lines and
 * entries the Inbox's log names; for a book it cannot follow (the first reading, another book, a long run of
 * revisions, lines made again) the whole of it. The state is read before, so everything here is one stretch
 * with no waiting, and nothing else changes what is stored in the middle of it. */
export function advance(
  service: ApplicationService,
  learner: Learner,
  state: BookState,
  lines: PostedLines,
): Through {
  const at = positionOf(state);
  const inbox = changesSince(service, learner.through?.changes ?? 0);
  let whole = learner.through === null || learner.lines !== lines;
  const keys = new Set<string>();
  if (!whole && learner.through !== null) {
    const revisions = revisionsAfter(state, learner.through.position);
    if (revisions === null) whole = true;
    else {
      const delta = deltaOf(revisions);
      for (const booked of delta.journals) keys.add(`journal:${booked.journal.id}`);
      for (const link of delta.links) {
        keys.add(`journal:${link.originalJournalId}`);
        keys.add(`journal:${link.correctionJournalId}`);
      }
    }
  }
  if (whole) everything(service, learner, lines);
  else {
    for (const id of inbox.journalIds) keys.add(`journal:${id}`);
    for (const id of inbox.itemIds) {
      keys.add(`decision:${id}`);
      const journalId = itemJournal(service, id);
      if (journalId !== null) keys.add(`journal:${journalId}`);
    }
    for (const key of keys)
      retarget(
        learner,
        key,
        isDecisionKey(key)
          ? ofDecision(service, key.slice("decision:".length))
          : ofJournal(service, lines, key.slice("journal:".length)),
      );
  }
  learner.lines = lines;
  learner.through = { position: at, changes: inbox.latest };
  return learner.through;
}

/** What taking `pending` in did to what the proposers read, for the lines that wait: the classifier may
 * suggest for a line only through a word with a record behind it (`hasStrongWord`), and the starter list
 * only through the accounts a merchant's lines went to. When neither could have changed, no line's
 * suggestions can have. */
export interface Effect {
  readonly classifier: boolean;
  readonly starter: boolean;
}

/** Move what is held from the examples as stored to the examples as the book says (`pending`), and tell
 * what that could change in the suggestions. Memory only: the caller writes the table. */
export function take(learner: Learner, minExamples: number, enabled: boolean): Effect {
  const before = enabled && learner.model.hasStrongWord(minExamples);
  let starter = false;
  for (const [key, example] of learner.pending) {
    const held = learner.stored.get(key);
    if (held !== undefined) {
      learner.model.removeExample(held);
      if (learner.history.remove(held) !== null) starter = true;
      learner.stored.delete(key);
      if (isDecisionKey(key)) learner.decisions -= 1;
    }
    if (example !== null) {
      learner.model.addExample(example);
      if (learner.history.add(example) !== null) starter = true;
      learner.stored.set(key, example);
      if (isDecisionKey(key)) learner.decisions += 1;
    }
  }
  learner.pending.clear();
  const after = enabled && learner.model.hasStrongWord(minExamples);
  return { classifier: before || after, starter };
}

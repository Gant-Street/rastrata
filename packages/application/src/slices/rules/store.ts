import { ApplicationError } from "../../errors.ts";
import {
  CONFIG_LIMITS,
  type ClassifierConfig,
  DEFAULT_CLASSIFIER_CONFIG,
  type Direction,
  type TrainingExample,
} from "../../rules/classifier.ts";
import type { Position } from "../../reports/ledger-history.ts";
import type { EvaluationReport } from "../../rules/evaluate.ts";
import type { Rule, RuleAuthor, RuleDefinition } from "../../rules/types.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";
import type { ApplicationService } from "../../service.ts";

/** Product state for the rules lane, in the application's own SQLite store (never the kernel's).
 *
 * - `rules_rule`: the current definition of every rule, active or retired, with its place in the
 *   priority order.
 * - `rules_revision`: every revision of every rule, append-only. Nothing a rule ever said is
 *   erased, so "why was this line booked there" can always be answered.
 * - `rules_meta`: counters and settings (rules revision, classifier thresholds and training state).
 * - `rules_example`: what the classifier learns from, one row per past decision. It is derived
 *   data: training rebuilds it from the ledger, so it can always be thrown away and regenerated.
 *
 * Migrations are append-only. Never edit a released step; add one. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE rules_rule (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
     position INTEGER NOT NULL,
     revision INTEGER NOT NULL,
     body TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_by TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX rules_rule_order ON rules_rule (status, position)`,
  `CREATE TABLE rules_revision (
     rule_id TEXT NOT NULL,
     revision INTEGER NOT NULL,
     body TEXT NOT NULL,
     made_by TEXT NOT NULL,
     made_at TEXT NOT NULL,
     changed TEXT NOT NULL,
     note TEXT,
     PRIMARY KEY (rule_id, revision)
   )`,
  `CREATE TABLE rules_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE rules_example (
     key TEXT PRIMARY KEY,
     account_id TEXT NOT NULL,
     text TEXT NOT NULL,
     direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
     on_date TEXT NOT NULL,
     origin TEXT NOT NULL
   )`,
  `CREATE INDEX rules_example_origin ON rules_example (origin)`,
  // The bank or card account a line was on: what lets the classifier tell what a statement writes
  // into every line from what names a merchant. Null for examples learned before it was kept.
  `ALTER TABLE rules_example ADD COLUMN source_id TEXT`,
];

/** The most active rules a book may hold. Every line is tested against every rule, so the bound
 * keeps a run of thousands of lines fast and predictable. */
export const MAX_ACTIVE_RULES = 500;

export interface RulesState {
  /** The clock for timestamps: an ISO instant, the service's own clock unless a test replaces it. */
  now: () => string;
  /** Today's local calendar date, YYYY-MM-DD, never converted through a timezone: the service's. */
  today: () => string;
}

export function rulesState(service: ApplicationService): RulesState {
  return sliceState(service, "rules", (store) => {
    migrate(store, "rules", MIGRATIONS);
    return { now: () => service.now(), today: () => service.today() } satisfies RulesState;
  });
}

/** Replace the clocks a book's rules lane reads time from (tests; there is no other caller). */
export function setRulesClock(
  service: ApplicationService,
  clock: { now: () => string; today: () => string },
): void {
  const state = rulesState(service);
  state.now = clock.now;
  state.today = clock.today;
}

function parse<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApplicationError(
      "rules_state_corrupt",
      `The stored ${what} could not be read; restore from a backup`,
      503,
    );
  }
}

interface RuleRow {
  id: string;
  status: "active" | "deleted";
  position: number;
  revision: number;
  body: string;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

export type StoredRule = Rule & { readonly status: "active" | "deleted" };

function toRule(row: RuleRow): StoredRule {
  const definition = parse<RuleDefinition>(row.body, "rule");
  return {
    ...definition,
    id: row.id,
    status: row.status,
    priority: row.position,
    revision: row.revision,
    createdBy: parse<RuleAuthor>(row.created_by, "rule author"),
    createdAt: row.created_at,
    updatedBy: parse<RuleAuthor>(row.updated_by, "rule author"),
    updatedAt: row.updated_at,
  };
}

export function readRules(
  store: ApplicationStore,
  status: "active" | "deleted" = "active",
): StoredRule[] {
  const rows = store
    .query(
      status === "active"
        ? "SELECT * FROM rules_rule WHERE status='active' ORDER BY position"
        : "SELECT * FROM rules_rule WHERE status='deleted' ORDER BY updated_at DESC, id",
    )
    .all() as RuleRow[];
  return rows.map(toRule);
}

export function readRule(store: ApplicationStore, id: string): StoredRule | null {
  const row = store.query("SELECT * FROM rules_rule WHERE id=?").get(id) as RuleRow | null;
  return row ? toRule(row) : null;
}

/** The fixed-order JSON of a definition, so equal definitions are equal strings. */
export function definitionJson(rule: RuleDefinition): string {
  return JSON.stringify({
    name: rule.name,
    enabled: rule.enabled,
    accountIds: rule.accountIds,
    match: rule.match,
    conditions: rule.conditions.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      ...(condition.value !== undefined ? { value: condition.value } : {}),
      ...(condition.min !== undefined ? { min: condition.min } : {}),
      ...(condition.max !== undefined ? { max: condition.max } : {}),
      ...(condition.negate ? { negate: true } : {}),
    })),
    groups: rule.groups.map((group) => ({
      mode: group.mode,
      conditions: group.conditions.map((condition) => ({
        field: condition.field,
        operator: condition.operator,
        ...(condition.value !== undefined ? { value: condition.value } : {}),
        ...(condition.min !== undefined ? { min: condition.min } : {}),
        ...(condition.max !== undefined ? { max: condition.max } : {}),
        ...(condition.negate ? { negate: true } : {}),
      })),
    })),
    action: {
      kind: rule.action.kind,
      ...(rule.action.accountId !== undefined ? { accountId: rule.action.accountId } : {}),
      ...(rule.action.allocations !== undefined
        ? {
            allocations: rule.action.allocations.map((part) => ({
              accountId: part.accountId,
              ...(part.percent !== undefined ? { percent: part.percent } : {}),
              ...(part.amount !== undefined ? { amount: part.amount } : {}),
              ...(part.rest ? { rest: true } : {}),
            })),
          }
        : {}),
      ...(rule.action.narration !== undefined ? { narration: rule.action.narration } : {}),
      ...(rule.action.reason !== undefined ? { reason: rule.action.reason } : {}),
    },
    ...(rule.note !== undefined ? { note: rule.note } : {}),
  });
}

export function saveRule(store: ApplicationStore, rule: StoredRule): void {
  store
    .query(
      `INSERT INTO rules_rule (id, status, position, revision, body, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, position=excluded.position,
         revision=excluded.revision, body=excluded.body, updated_by=excluded.updated_by,
         updated_at=excluded.updated_at`,
    )
    .run(
      rule.id,
      rule.status,
      rule.priority,
      rule.revision,
      definitionJson(rule),
      JSON.stringify(rule.createdBy),
      rule.createdAt,
      JSON.stringify(rule.updatedBy),
      rule.updatedAt,
    );
}

/** Give the active rules the positions 1..n in the order of `ids`. */
export function setPositions(store: ApplicationStore, ids: readonly string[]): void {
  for (const [index, id] of ids.entries())
    store
      .query("UPDATE rules_rule SET position=? WHERE id=? AND status='active'")
      .run(index + 1, id);
}

export interface RevisionRow {
  readonly revision: number;
  readonly madeBy: RuleAuthor;
  readonly madeAt: string;
  readonly changed: readonly string[];
  readonly note: string | null;
}

export function appendRevision(
  store: ApplicationStore,
  rule: StoredRule,
  changed: readonly string[],
  note: string | null,
): void {
  store
    .query(
      "INSERT INTO rules_revision (rule_id, revision, body, made_by, made_at, changed, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      rule.id,
      rule.revision,
      definitionJson(rule),
      JSON.stringify(rule.updatedBy),
      rule.updatedAt,
      JSON.stringify(changed),
      note,
    );
}

export function readRevisions(store: ApplicationStore, id: string): RevisionRow[] {
  const rows = store
    .query(
      "SELECT revision, made_by, made_at, changed, note FROM rules_revision WHERE rule_id=? ORDER BY revision",
    )
    .all(id) as {
    revision: number;
    made_by: string;
    made_at: string;
    changed: string;
    note: string | null;
  }[];
  return rows.map((row) => ({
    revision: row.revision,
    madeBy: parse<RuleAuthor>(row.made_by, "revision author"),
    madeAt: row.made_at,
    changed: parse<string[]>(row.changed, "revision"),
    note: row.note,
  }));
}

function metaGet(store: ApplicationStore, key: string): string | null {
  const row = store.query("SELECT value FROM rules_meta WHERE key=?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

function metaSet(store: ApplicationStore, key: string, value: string): void {
  store
    .query(
      "INSERT INTO rules_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(key, value);
}

/** Changes whenever any rule is created, changed, deleted or reordered. */
export function rulesRevision(store: ApplicationStore): number {
  return Number(metaGet(store, "rules_revision") ?? "0");
}

export function bumpRulesRevision(store: ApplicationStore): number {
  const next = rulesRevision(store) + 1;
  metaSet(store, "rules_revision", String(next));
  return next;
}

/** Who last set the priority order, and when. */
export function readOrderChange(
  store: ApplicationStore,
): { madeBy: RuleAuthor; madeAt: string } | null {
  const raw = metaGet(store, "order_changed");
  return raw ? parse<{ madeBy: RuleAuthor; madeAt: string }>(raw, "order record") : null;
}

export function writeOrderChange(
  store: ApplicationStore,
  madeBy: RuleAuthor,
  madeAt: string,
): void {
  metaSet(store, "order_changed", JSON.stringify({ madeBy, madeAt }));
}

/** The stored thresholds. Only known fields are read and each is kept inside its limits, so a
 * hand-edited or older record can never put a value on the wire the schema would refuse. */
export function readConfig(store: ApplicationStore): ClassifierConfig {
  const raw = metaGet(store, "classifier_config");
  if (!raw) return DEFAULT_CLASSIFIER_CONFIG;
  const stored = parse<Record<string, unknown>>(raw, "classifier settings");
  const number = (key: keyof typeof CONFIG_LIMITS): number => {
    const value = stored[key];
    const { min, max } = CONFIG_LIMITS[key];
    return typeof value === "number" && Number.isInteger(value)
      ? Math.min(max, Math.max(min, value))
      : DEFAULT_CLASSIFIER_CONFIG[key];
  };
  return {
    enabled:
      typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_CLASSIFIER_CONFIG.enabled,
    minAgreement: number("minAgreement"),
    minMargin: number("minMargin"),
    minExamples: number("minExamples"),
    minKnownWords: number("minKnownWords"),
  };
}

export function writeConfig(store: ApplicationStore, config: ClassifierConfig): void {
  metaSet(store, "classifier_config", JSON.stringify(config));
}

/** An evaluation as stored with the training it measured. */
export interface StoredEvaluation {
  readonly config: ClassifierConfig;
  readonly report: EvaluationReport;
  readonly computedAt: string;
}

/** What the examples were last made equal to the book through: the place in the book's hash chain whose
 * entries have been taken in, and the last change among the Inbox's lines (`app_ingest_changes`) that has. */
export interface Through {
  readonly position: Position;
  readonly changes: number;
}

export interface TrainingState {
  /** Changes whenever the examples the classifier knows change. */
  readonly modelVersion: number;
  readonly trainedAt: string | null;
  readonly trainedThroughRevision: string | null;
  /** Where in the book's hash chain, and in the log of changes among the Inbox's lines, the examples were
   * last made equal to what the book says; null when that is not known (the examples were written by a
   * training on request, or before this was kept), so the next learning reads the whole book. */
  readonly through: Through | null;
  readonly sources: { readonly posted: number; readonly decisions: number };
  /** The measurement of the history the classifier learned from, as it stood when the learning was asked for
   * (a training on request); null after the classifier learned by itself, which does not measure: the card
   * that shows it measures when it is read. */
  readonly evaluation: StoredEvaluation | null;
  /** How many example rows a learning on the classifier's own account would have written when it
   * held back because the history is long; 0 when it did not. The book revision it held back at is
   * kept so the question is not worked out again until the book moves. */
  readonly heldBack: number;
  readonly heldBackRevision: string | null;
}

/** What was stored of where the examples were last made equal to the book, written by `writeTraining`. */
function readThrough(stored: unknown): Through | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { revision, chainHash, changes } = stored as {
    revision?: unknown;
    chainHash?: unknown;
    changes?: unknown;
  };
  if (typeof revision !== "string" || typeof changes !== "number") return null;
  if (chainHash !== null && (typeof chainHash !== "object" || chainHash === undefined)) return null;
  try {
    return {
      position: { revision: BigInt(revision), chainHash: chainHash as Position["chainHash"] },
      changes,
    };
  } catch {
    return null;
  }
}

export function readTraining(store: ApplicationStore): TrainingState {
  const raw = metaGet(store, "classifier_training");
  const stored = raw ? parse<Partial<TrainingState>>(raw, "classifier training state") : {};
  return {
    modelVersion: stored.modelVersion ?? 0,
    trainedAt: stored.trainedAt ?? null,
    trainedThroughRevision: stored.trainedThroughRevision ?? null,
    through: readThrough(stored.through),
    sources: stored.sources ?? { posted: 0, decisions: 0 },
    evaluation: stored.evaluation ?? null,
    heldBack: stored.heldBack ?? 0,
    heldBackRevision: stored.heldBackRevision ?? null,
  };
}

export function writeTraining(store: ApplicationStore, state: TrainingState): void {
  const { through, ...rest } = state;
  metaSet(
    store,
    "classifier_training",
    JSON.stringify({
      ...rest,
      through:
        through === null
          ? null
          : {
              revision: through.position.revision.toString(),
              chainHash: through.position.chainHash,
              changes: through.changes,
            },
    }),
  );
}

export function readExamples(store: ApplicationStore): TrainingExample[] {
  const rows = store
    .query(
      "SELECT key, account_id, text, direction, on_date, source_id FROM rules_example ORDER BY on_date, key",
    )
    .all() as {
    key: string;
    account_id: string;
    text: string;
    direction: Direction;
    on_date: string;
    source_id: string | null;
  }[];
  return rows.map((row) => ({
    key: row.key,
    accountId: row.account_id,
    text: row.text,
    direction: row.direction,
    on: row.on_date,
    ...(row.source_id !== null ? { source: row.source_id } : {}),
  }));
}

/** The rows that make the table hold `examples` and nothing else: the examples that are new or that
 * changed, and the keys that are gone. Pure, so a learning can see its size before it writes. */
export function exampleChanges(
  current: readonly TrainingExample[],
  examples: readonly TrainingExample[],
): { readonly upserts: TrainingExample[]; readonly removals: string[] } {
  const same = (a: TrainingExample, b: TrainingExample) =>
    a.accountId === b.accountId &&
    a.text === b.text &&
    a.direction === b.direction &&
    a.on === b.on &&
    (a.source ?? null) === (b.source ?? null);
  const have = new Map(current.map((example) => [example.key, example]));
  const wanted = new Set(examples.map((example) => example.key));
  return {
    upserts: examples.filter((example) => {
      const existing = have.get(example.key);
      return existing === undefined || !same(existing, example);
    }),
    removals: [...have.keys()].filter((key) => !wanted.has(key)),
  };
}

/** Make the table hold exactly `examples`, writing only what differs, so a training after a few new
 * postings writes a few rows and not the whole history (a hosted book's request is one log entry,
 * and a long history rewritten whole would not fit in it). A key starting `decision:` came from a
 * line decided in the Inbox, anything else from a posted journal. */
export function syncExamples(
  store: ApplicationStore,
  examples: readonly TrainingExample[],
): { readonly written: number } {
  const changes = exampleChanges(readExamples(store), examples);
  const insert = store.query(
    "INSERT OR REPLACE INTO rules_example (key, account_id, text, direction, on_date, origin, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const example of changes.upserts)
    insert.run(
      example.key,
      example.accountId,
      example.text,
      example.direction,
      example.on,
      example.key.startsWith("decision:") ? "decision" : "journal",
      example.source ?? null,
    );
  const remove = store.query("DELETE FROM rules_example WHERE key=?");
  for (const key of changes.removals) remove.run(key);
  return { written: changes.upserts.length + changes.removals.length };
}

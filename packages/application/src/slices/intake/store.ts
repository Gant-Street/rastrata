import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import {
  FRICTION_CLASS,
  FRICTION_CLASSES,
  FRICTION_KINDS,
  type FrictionClass,
  type FrictionKind,
} from "../../intake/sets.ts";
import { migrate, sliceState } from "../state.ts";

/** Product state of the intake lane: the friction log.
 *
 * It lives in the book's own database, not in a file beside it, for three reasons. It is the
 * history of one book's move-in, so it travels with the book and is backed up and restored with it.
 * It is written by a retained operation, so a lost reply finds the first answer and never records an
 * event twice. And a hosted book has no folder to keep a file in. The text of an event is cleaned
 * before it is stored, so what is exported later is as safe as what was shown. */

const STEPS = [
  `CREATE TABLE app_intake_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     operation_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     class TEXT NOT NULL,
     key TEXT,
     source TEXT NOT NULL,
     reason TEXT NOT NULL,
     actor TEXT NOT NULL,
     at TEXT NOT NULL,
     resolved_at TEXT,
     resolved_by TEXT,
     resolution TEXT
   );
   CREATE INDEX app_intake_events_key ON app_intake_events (key);
   CREATE INDEX app_intake_events_open ON app_intake_events (resolved_at, class);`,
  // Recipes: the recipe as saved, the proof it passed, and the import profile that runs it.
  `CREATE TABLE app_intake_recipes (
     name TEXT PRIMARY KEY COLLATE NOCASE,
     revision INTEGER NOT NULL,
     recipe TEXT NOT NULL,
     proven TEXT NOT NULL,
     profile_id TEXT NOT NULL,
     ledger_account_id TEXT,
     saved_at TEXT NOT NULL,
     saved_by TEXT NOT NULL
   );`,
];

export interface IntakeState {
  readonly store: ApplicationStore;
}

export function intakeState(service: ApplicationService): IntakeState {
  return sliceState(service, "intake", (store) => {
    migrate(store, "intake", STEPS);
    return { store };
  });
}

export interface NewEvent {
  readonly kind: FrictionKind;
  readonly source: string;
  readonly reason: string;
  readonly key: string | null;
}

export interface StoredEvent {
  readonly id: number;
  readonly kind: FrictionKind;
  readonly class: FrictionClass;
  readonly key: string | null;
  readonly source: string;
  readonly reason: string;
  readonly actor: string;
  readonly at: string;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
}

interface Row {
  id: number;
  kind: string;
  class: string;
  key: string | null;
  source: string;
  reason: string;
  actor: string;
  at: string;
  resolved_at: string | null;
  resolution: string | null;
}

const toEvent = (row: Row): StoredEvent => ({
  id: row.id,
  kind: row.kind as FrictionKind,
  class: row.class as FrictionClass,
  key: row.key,
  source: row.source,
  reason: row.reason,
  actor: row.actor,
  at: row.at,
  resolvedAt: row.resolved_at,
  resolution: row.resolution,
});

export interface WriteResult {
  readonly recorded: number;
  readonly deduplicated: number;
  readonly resolved: number;
  readonly ids: readonly number[];
}

/** Record events and resolve keys in one transaction. An event with a key that an open event
 * already has is that event again, not a new one. */
export function writeEvents(
  state: IntakeState,
  operationId: string,
  events: readonly NewEvent[],
  resolve: readonly string[],
  note: string,
  actor: string,
  at: string,
): WriteResult {
  return state.store.transaction(() => {
    let recorded = 0;
    let deduplicated = 0;
    const ids: number[] = [];
    for (const event of events) {
      if (event.key !== null) {
        const open = state.store
          .query("SELECT id FROM app_intake_events WHERE key=? AND resolved_at IS NULL LIMIT 1")
          .get(event.key) as { id: number } | null;
        if (open) {
          deduplicated++;
          continue;
        }
      }
      const result = state.store
        .query(
          "INSERT INTO app_intake_events (operation_id, kind, class, key, source, reason, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .get(
          operationId,
          event.kind,
          FRICTION_CLASS[event.kind],
          event.key,
          event.source,
          event.reason,
          actor,
          at,
        ) as { id: number };
      ids.push(result.id);
      recorded++;
    }
    let resolved = 0;
    for (const key of resolve) {
      const rows = state.store
        .query(
          "UPDATE app_intake_events SET resolved_at=?, resolved_by=?, resolution=? WHERE key=? AND resolved_at IS NULL RETURNING id",
        )
        .all(at, actor, note, key) as { id: number }[];
      resolved += rows.length;
    }
    return { recorded, deduplicated, resolved, ids };
  });
}

export interface EventFilter {
  readonly status: "open" | "resolved" | "all";
  readonly kind?: FrictionKind;
}

export function listEvents(
  state: IntakeState,
  filter: EventFilter,
  page: number,
  pageSize: number,
): { count: number; events: StoredEvent[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status === "open") where.push("resolved_at IS NULL");
  else if (filter.status === "resolved") where.push("resolved_at IS NOT NULL");
  if (filter.kind !== undefined) {
    where.push("kind=?");
    params.push(filter.kind);
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const count = (
    state.store.query(`SELECT COUNT(*) AS n FROM app_intake_events${clause}`).get(...params) as {
      n: number;
    }
  ).n;
  const rows = state.store
    .query(`SELECT * FROM app_intake_events${clause} ORDER BY id ASC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as Row[];
  return { count, events: rows.map(toEvent) };
}

export interface EventStats {
  readonly total: number;
  readonly byClass: Readonly<Record<FrictionClass, number>>;
  readonly byKind: readonly { kind: FrictionKind; count: number }[];
  readonly openGaps: number;
  readonly firstAt: string | null;
}

export function eventStats(state: IntakeState): EventStats {
  const byClass = Object.fromEntries(FRICTION_CLASSES.map((name) => [name, 0])) as Record<
    FrictionClass,
    number
  >;
  for (const row of state.store
    .query("SELECT class, COUNT(*) AS n FROM app_intake_events GROUP BY class")
    .all() as { class: FrictionClass; n: number }[])
    byClass[row.class] = row.n;
  const kinds = new Map<string, number>();
  for (const row of state.store
    .query("SELECT kind, COUNT(*) AS n FROM app_intake_events GROUP BY kind")
    .all() as { kind: string; n: number }[])
    kinds.set(row.kind, row.n);
  const byKind = FRICTION_KINDS.filter((kind) => kinds.has(kind)).map((kind) => ({
    kind,
    count: kinds.get(kind) as number,
  }));
  const openGaps = (
    state.store
      .query(
        "SELECT COUNT(*) AS n FROM app_intake_events WHERE class='gap' AND resolved_at IS NULL",
      )
      .get() as { n: number }
  ).n;
  const first = state.store.query("SELECT MIN(at) AS at FROM app_intake_events").get() as {
    at: string | null;
  };
  const total = Object.values(byClass).reduce((sum, value) => sum + value, 0);
  return { total, byClass, byKind, openGaps, firstAt: first.at };
}

// ---- Recipes ------------------------------------------------------------------------------

export interface StoredRecipe {
  readonly name: string;
  readonly revision: number;
  readonly recipe: unknown;
  readonly proven: unknown;
  readonly profileId: string;
  readonly ledgerAccountId: string | null;
  readonly savedAt: string;
  readonly savedBy: string;
}

interface RecipeRow {
  name: string;
  revision: number;
  recipe: string;
  proven: string;
  profile_id: string;
  ledger_account_id: string | null;
  saved_at: string;
  saved_by: string;
}

const toRecipe = (row: RecipeRow): StoredRecipe => ({
  name: row.name,
  revision: row.revision,
  recipe: JSON.parse(row.recipe),
  proven: JSON.parse(row.proven),
  profileId: row.profile_id,
  ledgerAccountId: row.ledger_account_id,
  savedAt: row.saved_at,
  savedBy: row.saved_by,
});

export function saveRecipe(
  state: IntakeState,
  value: {
    name: string;
    recipe: unknown;
    proven: unknown;
    profileId: string;
    ledgerAccountId: string | null;
    at: string;
    by: string;
  },
): StoredRecipe {
  return state.store.transaction(() => {
    const row = state.store
      .query("SELECT revision FROM app_intake_recipes WHERE name=?")
      .get(value.name) as { revision: number } | null;
    const revision = (row?.revision ?? 0) + 1;
    state.store
      .query(
        `INSERT INTO app_intake_recipes (name, revision, recipe, proven, profile_id, ledger_account_id, saved_at, saved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET revision=excluded.revision, recipe=excluded.recipe, proven=excluded.proven,
           profile_id=excluded.profile_id, ledger_account_id=excluded.ledger_account_id, saved_at=excluded.saved_at, saved_by=excluded.saved_by`,
      )
      .run(
        value.name,
        revision,
        JSON.stringify(value.recipe),
        JSON.stringify(value.proven),
        value.profileId,
        value.ledgerAccountId,
        value.at,
        value.by,
      );
    const saved = state.store
      .query("SELECT * FROM app_intake_recipes WHERE name=?")
      .get(value.name) as RecipeRow;
    return toRecipe(saved);
  });
}

export function listRecipes(state: IntakeState): StoredRecipe[] {
  return (
    state.store
      .query("SELECT * FROM app_intake_recipes ORDER BY name COLLATE NOCASE")
      .all() as RecipeRow[]
  ).map(toRecipe);
}

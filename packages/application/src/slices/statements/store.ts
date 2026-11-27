import { ApplicationError } from "../../errors.ts";
import type { CsvMapping } from "../../statements/csv-mapping.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";

/** Product state of the statements lane: saved column mappings, and a record of each import so a
 * retried commit sends the pipeline exactly the batch it sent the first time. */

const STEPS = [
  `CREATE TABLE app_statement_profiles (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL COLLATE NOCASE UNIQUE,
     ledger_account_id TEXT,
     preset_id TEXT,
     mapping TEXT NOT NULL,
     version INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX app_statement_profiles_account ON app_statement_profiles (ledger_account_id);
   CREATE TABLE app_import_runs (
     operation_id TEXT PRIMARY KEY,
     sha256 TEXT NOT NULL,
     ledger_account_id TEXT NOT NULL,
     fetched_at TEXT NOT NULL,
     batch_id TEXT,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
  // What a person sees in the import history: the file, the source and what the import did.
  `ALTER TABLE app_import_runs ADD COLUMN file_name TEXT;
   ALTER TABLE app_import_runs ADD COLUMN source_key TEXT;
   ALTER TABLE app_import_runs ADD COLUMN counts TEXT;
   ALTER TABLE app_import_runs ADD COLUMN completed_at TEXT;
   ALTER TABLE app_import_runs ADD COLUMN completed_on TEXT;`,
];

export interface StatementsState {
  readonly store: ApplicationStore;
  /** Parsed statements by what was parsed, so paging a preview does not parse the file again. A
   * convenience only: the parse is a pure function of its inputs, so a miss changes nothing. */
  readonly parsed: Map<string, unknown>;
}

export function statementsState(service: ApplicationService): StatementsState {
  return sliceState(service, "statements", (store) => {
    migrate(store, "statements", STEPS);
    return { store, parsed: new Map<string, unknown>() };
  });
}

export interface StoredProfile {
  readonly id: string;
  readonly name: string;
  readonly ledgerAccountId: string | null;
  readonly presetId: string | null;
  readonly mapping: CsvMapping;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProfileRow {
  id: string;
  name: string;
  ledger_account_id: string | null;
  preset_id: string | null;
  mapping: string;
  version: number;
  created_at: string;
  updated_at: string;
}

const toProfile = (row: ProfileRow): StoredProfile => ({
  id: row.id,
  name: row.name,
  ledgerAccountId: row.ledger_account_id,
  presetId: row.preset_id,
  mapping: JSON.parse(row.mapping) as CsvMapping,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const MAX_PROFILES = 500;

export function listProfiles(state: StatementsState, ledgerAccountId?: string): StoredProfile[] {
  const rows = (
    ledgerAccountId === undefined
      ? state.store.query("SELECT * FROM app_statement_profiles ORDER BY name COLLATE NOCASE").all()
      : state.store
          .query(
            "SELECT * FROM app_statement_profiles WHERE ledger_account_id=? ORDER BY updated_at DESC, name COLLATE NOCASE",
          )
          .all(ledgerAccountId)
  ) as ProfileRow[];
  return rows.map(toProfile);
}

export function getProfile(state: StatementsState, id: string): StoredProfile | null {
  const row = state.store
    .query("SELECT * FROM app_statement_profiles WHERE id=?")
    .get(id) as ProfileRow | null;
  return row ? toProfile(row) : null;
}

/** Save under a name: a new profile, or a new version of the one with that name (compared ignoring
 * case). Runs inside the caller's retained request, so a retry changes nothing. */
export function saveProfile(
  state: StatementsState,
  input: {
    readonly name: string;
    readonly ledgerAccountId: string | null;
    readonly presetId: string | null;
    readonly mapping: CsvMapping;
  },
  now: string,
): StoredProfile {
  const name = input.name.trim();
  const existing = state.store
    .query("SELECT * FROM app_statement_profiles WHERE name=? COLLATE NOCASE")
    .get(name) as ProfileRow | null;
  const mapping = JSON.stringify(input.mapping);
  if (existing) {
    state.store
      .query(
        "UPDATE app_statement_profiles SET ledger_account_id=?, preset_id=?, mapping=?, version=version+1, updated_at=? WHERE id=?",
      )
      .run(input.ledgerAccountId, input.presetId, mapping, now, existing.id);
    return getProfile(state, existing.id) as StoredProfile;
  }
  const total = state.store.query("SELECT COUNT(*) AS n FROM app_statement_profiles").get() as {
    n: number;
  };
  if (total.n >= MAX_PROFILES)
    throw new ApplicationError(
      "profile_limit",
      `There are already ${MAX_PROFILES} saved profiles; delete some before saving another`,
      409,
    );
  const id = crypto.randomUUID();
  state.store
    .query(
      "INSERT INTO app_statement_profiles (id, name, ledger_account_id, preset_id, mapping, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .run(id, name, input.ledgerAccountId, input.presetId, mapping, now, now);
  return getProfile(state, id) as StoredProfile;
}

export function deleteProfile(state: StatementsState, id: string): boolean {
  return state.store.query("DELETE FROM app_statement_profiles WHERE id=?").run(id).changes > 0;
}

export interface ImportRun {
  readonly operationId: string;
  readonly sha256: string;
  readonly ledgerAccountId: string;
  readonly fetchedAt: string;
  readonly batchId: string | null;
  readonly status: "started" | "committed";
}

export function readRun(state: StatementsState, operationId: string): ImportRun | null {
  const row = state.store
    .query(
      "SELECT operation_id, sha256, ledger_account_id, fetched_at, batch_id, status FROM app_import_runs WHERE operation_id=?",
    )
    .get(operationId) as {
    operation_id: string;
    sha256: string;
    ledger_account_id: string;
    fetched_at: string;
    batch_id: string | null;
    status: "started" | "committed";
  } | null;
  return row
    ? {
        operationId: row.operation_id,
        sha256: row.sha256,
        ledgerAccountId: row.ledger_account_id,
        fetchedAt: row.fetched_at,
        batchId: row.batch_id,
        status: row.status,
      }
    : null;
}

/** Record that an import with this identity has begun, and when its batch was "fetched", before
 * anything is sent to the pipeline. A retry after a crash reads it back and builds the same batch. */
export function startRun(
  state: StatementsState,
  run: { operationId: string; sha256: string; ledgerAccountId: string; fetchedAt: string },
  now: string,
): ImportRun {
  state.store
    .query(
      "INSERT OR IGNORE INTO app_import_runs (operation_id, sha256, ledger_account_id, fetched_at, status, created_at) VALUES (?, ?, ?, ?, 'started', ?)",
    )
    .run(run.operationId, run.sha256, run.ledgerAccountId, run.fetchedAt, now);
  return readRun(state, run.operationId) as ImportRun;
}

export interface FinishedImport {
  readonly batchId: string;
  readonly fileName: string | null;
  readonly sourceKey: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly completedAt: string;
  /** The local date the import finished on, as the person's calendar read it. */
  readonly completedOn: string;
}

export function finishRun(state: StatementsState, operationId: string, done: FinishedImport): void {
  state.store
    .query(
      "UPDATE app_import_runs SET status='committed', batch_id=?, file_name=?, source_key=?, counts=?, completed_at=?, completed_on=? WHERE operation_id=?",
    )
    .run(
      done.batchId,
      done.fileName,
      done.sourceKey,
      JSON.stringify(done.counts),
      done.completedAt,
      done.completedOn,
      operationId,
    );
}

export interface HistoryRow {
  readonly operationId: string;
  readonly batchId: string;
  readonly sha256: string;
  readonly fileName: string | null;
  readonly ledgerAccountId: string;
  readonly sourceKey: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly completedAt: string;
  readonly completedOn: string;
}

/** Committed imports, newest first. */
export function listRuns(
  state: StatementsState,
  page: number,
  pageSize: number,
): { count: number; rows: HistoryRow[] } {
  const total = state.store
    .query("SELECT COUNT(*) AS n FROM app_import_runs WHERE status='committed'")
    .get() as { n: number };
  const rows = state.store
    .query(
      "SELECT operation_id, batch_id, sha256, file_name, ledger_account_id, source_key, counts, completed_at, completed_on FROM app_import_runs WHERE status='committed' ORDER BY completed_at DESC, rowid DESC LIMIT ? OFFSET ?",
    )
    .all(pageSize, (page - 1) * pageSize) as {
    operation_id: string;
    batch_id: string;
    sha256: string;
    file_name: string | null;
    ledger_account_id: string;
    source_key: string | null;
    counts: string | null;
    completed_at: string | null;
    completed_on: string | null;
  }[];
  return {
    count: total.n,
    rows: rows.map((row) => ({
      operationId: row.operation_id,
      batchId: row.batch_id,
      sha256: row.sha256,
      fileName: row.file_name,
      ledgerAccountId: row.ledger_account_id,
      sourceKey: row.source_key ?? "",
      counts: row.counts ? (JSON.parse(row.counts) as Record<string, number>) : {},
      completedAt: row.completed_at ?? "",
      completedOn: row.completed_on ?? "",
    })),
  };
}

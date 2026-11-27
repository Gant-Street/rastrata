import type { Database, Statement } from "bun:sqlite";
import { createHash } from "node:crypto";
import { RowEncoder, type Change, type ChangeSet, type SqlValue, type TableSpec } from "./codec.ts";

/** Row-level change capture for one SQLite database, by triggers.
 *
 * Every replicated table gets an AFTER INSERT, UPDATE and DELETE trigger that writes into a shadow
 * table of its own inside the very transaction that changed the row, so a rollback (of the
 * request, or of an inner savepoint) leaves nothing, and what is captured is exactly what
 * committed. The shadow table has the table's columns without types, so SQLite copies every value
 * with the type it has: integers, reals, text and blobs arrive as they were. A shared `_cdc`
 * table orders the changes across tables.
 *
 * At the end of a request `peek()` turns what was captured into a {@link ChangeSet}; after the
 * entry is durable `settle()` forgets it. `apply()` replays a change set on another copy of the
 * database, with capture switched off and the application's own triggers set aside (the change set
 * already holds their effects). Schema changes are found by comparing `sqlite_master` with what
 * was last settled: a new or redefined table is sent whole (its definition, then all its rows), an
 * added column as an ALTER, other objects as their DDL.
 *
 * Tables the application derives from the rest (read caches) are named in `exclude` and neither
 * captured nor compared. Everything this class creates is named `_cdc…`. */

export interface CaptureOptions {
  /** Tables (and their indexes and triggers) that are not part of the book's replicated state. */
  readonly exclude?: readonly string[];
}

export interface Pending {
  readonly set: ChangeSet;
  /** How many changes it holds. */
  readonly count: number;
  /** Tables that went whole (new, redefined or repaired). */
  readonly resynced: readonly string[];
  readonly ddl: number;
  /** Opaque: what `settle` needs to record as the new baseline. */
  readonly baseline: Baseline;
  /** Opaque: the last captured change that was read, and the tables whose shadow rows were read.
   * `settle` forgets exactly these, so a change made after the peek is kept for the next entry. */
  readonly upTo: number;
  readonly touched: readonly number[];
}

interface SchemaObject {
  readonly type: "table" | "index" | "view" | "trigger";
  readonly name: string;
  readonly tbl: string;
  readonly sql: string;
}
interface Baseline {
  readonly objects: readonly SchemaObject[];
  readonly sequences: Readonly<Record<string, string>>;
}
interface Spec extends TableSpec {
  readonly id: number;
  /** The first column is the implicit rowid, kept so replicas preserve scan order. */
  readonly rowid: boolean;
  readonly withoutRowid: boolean;
  readonly autoincrement: boolean;
}

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

/** Make a statement return INTEGER columns as bigint, so none loses a digit (bun's own typings omit
 * the method). */
function exact<T extends Statement>(statement: T): T {
  (statement as unknown as { safeIntegers(on: boolean): void }).safeIntegers(true);
  return statement;
}

const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const internal = (name: string): boolean => name.startsWith("_cdc") || name.startsWith("sqlite_");

const OP = { insert: 1, update: 2, delete: 3 } as const;

/** What {@link ChangeCapture.stateDigest} reports. */
export interface StateDigest {
  readonly schema: string;
  readonly tables: Readonly<Record<string, { readonly rows: number; readonly hash: string }>>;
  readonly sequences: string;
  readonly overall: string;
}

/** The places two digests differ, in words ("table kv: 3 rows against 4"), or nothing when they are the same book. */
export function diffDigests(a: StateDigest, b: StateDigest): string[] {
  const out: string[] = [];
  if (a.schema !== b.schema) out.push("the schema");
  const names = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
  for (const name of [...names].sort()) {
    const left = a.tables[name];
    const right = b.tables[name];
    if (!left) out.push(`table ${name}: only in the second`);
    else if (!right) out.push(`table ${name}: only in the first`);
    else if (left.hash !== right.hash)
      out.push(
        left.rows === right.rows
          ? `table ${name}: ${left.rows} rows, different content`
          : `table ${name}: ${left.rows} rows against ${right.rows}`,
      );
  }
  if (a.sequences !== b.sequences) out.push("the autoincrement counters");
  return out;
}

export class ChangeCapture {
  readonly #db: Database;
  readonly #exclude: ReadonlySet<string>;
  #tables = new Map<string, Spec>();
  #schemaVersion = -1;
  /** The baseline as last recorded, so that a write that moved no schema does not read, compare or
   * write it again. Dropped when a rollback may have undone what it says. */
  #baseline: Baseline | null = null;
  #sequencesText = "";

  constructor(db: Database, options: CaptureOptions = {}) {
    this.#db = db;
    this.#exclude = new Set(options.exclude ?? []);
  }

  /** Create the machinery in the database (idempotent) and switch on what replay needs. */
  install(): void {
    // A REPLACE that removes a conflicting row must fire the DELETE trigger, or the removal would
    // never reach a replica. The setting belongs to the connection.
    this.#db.exec("PRAGMA recursive_triggers=ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS _cdc_gate (on_ INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS _cdc_state (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS _cdc (seq INTEGER PRIMARY KEY, t INTEGER NOT NULL, op INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS _cdc_tables (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, spec TEXT NOT NULL);
    `);
    if (!this.#db.query("SELECT 1 FROM _cdc_gate").get())
      this.#db.run("INSERT INTO _cdc_gate (on_) VALUES (1)");
    this.#baseline = null;
    this.#loadRegistry();
  }

  /** The captured changes since the last settle, or null when there are none. Also brings the
   * machinery in line with the schema: call it inside the transaction that will be committed or
   * rolled back with the entry. */
  peek(): Pending | null {
    const version = this.#version();
    const last = (
      this.#db.query("SELECT max(seq) AS upTo FROM _cdc").get() as { upTo: number | null }
    ).upTo;
    if (version === this.#schemaVersion && last === null) return null;

    // When the schema has not moved since the last look, there is nothing to compare: the objects are
    // the baseline's, and only rows (and counters) can have changed. Comparing the schema of every
    // table at every write was most of what capture cost.
    const quiet = version === this.#schemaVersion && this.#baseline !== null;
    const known = this.#known();
    const objects = quiet ? known.objects : this.#objects();
    const plan = quiet
      ? { ddl: [], resync: new Set<string>(), removed: [] }
      : this.#plan(objects, known);
    // Changes captured for a table that is dropped or sent whole are in the statement that drops it or
    // the whole table: they are not read.
    const skip = new Set<number>();
    for (const name of [...plan.removed, ...plan.resync]) {
      const id = this.#tables.get(name)?.id;
      if (id !== undefined) skip.add(id);
    }
    for (const name of plan.removed) this.#uninstall(name);
    for (const name of plan.resync) this.#instrument(name);

    const changes: Change[] = [];
    for (const sql of plan.ddl) changes.push({ op: "ddl", sql });
    const specs = new Map<string, TableSpec>();
    const spec = (name: string): Spec => {
      const found = this.#tables.get(name);
      if (!found) throw new CaptureError(`The table ${name} is not captured`);
      specs.set(name, { name: found.name, columns: found.columns, key: found.key });
      return found;
    };
    for (const name of plan.resync) {
      const found = spec(name);
      changes.push({ op: "replace", table: name, rows: this.#readAll(found) });
    }
    const touched = this.#readChanges(skip, changes, spec);
    const sequences = this.#sequences();
    const baseline: Baseline = { objects, sequences };
    for (const [name, value] of Object.entries(sequences))
      if (known.sequences[name] !== value)
        changes.push({ op: "sequence", name, value: BigInt(value) });
    this.#schemaVersion = this.#version();
    if (changes.length === 0) {
      // The schema moved without any effect on what is replicated (an excluded table, for example).
      this.#remember(baseline);
      return null;
    }
    return {
      set: { tables: [...specs.values()], changes },
      count: changes.length,
      resynced: [...plan.resync],
      ddl: plan.ddl.length,
      baseline,
      upTo: last ?? 0,
      touched: [...touched],
    };
  }

  /** The entry is durable: forget the captured changes and take its schema and counters as the
   * new baseline. Call it inside the same transaction as the local commit. */
  settle(pending: Pending): void {
    this.#db.run("DELETE FROM _cdc WHERE seq <= ?", [pending.upTo]);
    for (const id of pending.touched)
      this.#db.run(`DELETE FROM ${q(`_cdc_t${id}`)} WHERE seq <= ?`, [pending.upTo]);
    this.#remember(pending.baseline);
    this.#schemaVersion = this.#version();
  }

  /** Take the database as it stands as the baseline: install the machinery on every replicated table
   * and record the schema, without producing a change set. For a file that is about to become the
   * base snapshot of a log; everything in it is then "already sent". */
  adopt(): void {
    const objects = this.#objects();
    for (const object of objects) if (object.type === "table") this.#instrument(object.name);
    this.#remember({ objects, sequences: this.#sequences() });
    this.#schemaVersion = this.#version();
  }

  /** Forget what was learned about the database in memory: after a rollback has undone machinery that
   * was installed inside the transaction, the registry in the file is the truth again. */
  invalidate(): void {
    this.#schemaVersion = -1;
    this.#baseline = null;
    this.#loadRegistry();
  }

  /** Forget everything captured without sending it (tests). */
  discard(): void {
    this.#clear();
  }

  head(): { readonly bookId: string; readonly seq: number; readonly hash: string } | null {
    const row = this.#db.query("SELECT v FROM _cdc_state WHERE k='head'").get() as {
      v: string;
    } | null;
    return row ? (JSON.parse(row.v) as { bookId: string; seq: number; hash: string }) : null;
  }
  setHead(head: { readonly bookId: string; readonly seq: number; readonly hash: string }): void {
    this.#db.run(
      "INSERT INTO _cdc_state (k, v) VALUES ('head', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
      [JSON.stringify(head)],
    );
  }

  /** True when changes were captured and not yet settled. */
  get dirty(): boolean {
    return this.#db.query("SELECT 1 FROM _cdc LIMIT 1").get() !== null;
  }

  /** A value that differs from one taken earlier if anything was captured or the schema moved in
   * between (and that nothing else changes while no write can run): to tell what one read wrote from
   * what was already waiting. */
  mark(): string {
    const last = (
      this.#db.query("SELECT max(seq) AS last FROM _cdc").get() as { last: number | null }
    ).last;
    return `${this.#version()}:${last ?? 0}`;
  }

  /** True when the database holds something the log does not: rows captured and not yet settled, or a
   * schema that moved in a way that would be sent. Cheap when nothing moved (one pragma and one
   * lookup); when the schema moved without effect on what is replicated (a derived table was made)
   * it notes that and says no. Never changes the database. */
  hasUnsent(): boolean {
    if (this.dirty) return true;
    const version = this.#version();
    if (version === this.#schemaVersion) return false;
    const plan = this.#plan(this.#objects(), this.#known());
    if (plan.ddl.length > 0 || plan.resync.size > 0 || plan.removed.length > 0) return true;
    this.#schemaVersion = version;
    return false;
  }

  // ---- replay -------------------------------------------------------------------------------------

  /** Replay a change set. Run it inside a transaction, with foreign keys off (a pragma that cannot
   * change inside one): the set already holds every cascaded change in the order it happened. */
  apply(set: ChangeSet): void {
    this.#replay([set]);
  }

  /** Replay change sets one after another, as `apply` would each. Sets that change no schema are replayed together:
   * the application's triggers are set aside once for the run and put back once after it, where `apply` does both for
   * every set. That was most of what replaying an entry cost (measured 2026-11-19: 1.7 to 2.9 ms an entry, whatever
   * the entry held). A set that changes the schema is replayed by itself, exactly as before, so what is set aside and
   * what is put back are the same triggers a set at a time would have had. */
  applyAll(sets: readonly ChangeSet[]): void {
    let run: ChangeSet[] = [];
    const flush = () => {
      if (run.length > 0) this.#replay(run);
      run = [];
    };
    for (const set of sets) {
      if (set.changes.some((change) => change.op === "ddl")) {
        flush();
        this.#replay([set]);
      } else run.push(set);
    }
    flush();
  }

  /** One set, or several that change no schema. */
  #replay(sets: readonly ChangeSet[]): void {
    this.#db.run("UPDATE _cdc_gate SET on_=0");
    const set_aside = this.#db
      .query(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE '\\_cdc%' ESCAPE '\\' AND sql IS NOT NULL",
      )
      .all() as { name: string; tbl_name: string; sql: string }[];
    for (const trigger of set_aside) this.#db.exec(`DROP TRIGGER ${q(trigger.name)}`);
    const wanted = new Map(set_aside.map((trigger) => [trigger.name, trigger] as const));
    const cache = new Map<string, Statement>();
    const prepare = (sql: string): Statement => {
      let statement = cache.get(sql);
      if (!statement) {
        statement = this.#db.query(sql);
        cache.set(sql, statement);
      }
      return statement;
    };
    try {
      for (const set of sets) {
        const specs = new Map(set.tables.map((table) => [table.name, table] as const));
        for (const change of set.changes) {
          switch (change.op) {
            case "ddl": {
              const trigger =
                /^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|\S+)/i.exec(
                  change.sql,
                );
              const dropped =
                /^\s*DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?("(?:[^"]|"")+"|[^\s;]+)/i.exec(
                  change.sql,
                );
              if (trigger) {
                const name = unquote(trigger[1] as string);
                wanted.set(name, { name, tbl_name: "", sql: change.sql });
              } else if (dropped) {
                wanted.delete(unquote(dropped[1] as string));
              } else {
                this.#db.exec(change.sql);
                cache.clear();
              }
              break;
            }
            case "insert": {
              const table = this.#specFor(specs, change.table);
              const { sql, params } = insertStatement(table, change.row);
              prepare(sql).run(...params);
              break;
            }
            case "update": {
              const table = this.#specFor(specs, change.table);
              const { sql, params } = updateStatement(table, change.key, change.row);
              const result = prepare(sql).run(...params);
              if (result.changes !== 1)
                throw new CaptureError(`The row to update in ${table.name} was not there`);
              break;
            }
            case "delete": {
              const table = this.#specFor(specs, change.table);
              const { sql, params } = deleteStatement(table, change.key);
              const result = prepare(sql).run(...params);
              if (result.changes !== 1)
                throw new CaptureError(`The row to delete from ${table.name} was not there`);
              break;
            }
            case "replace": {
              const table = this.#specFor(specs, change.table);
              this.#db.run(`DELETE FROM ${q(table.name)}`);
              for (const row of change.rows) {
                const { sql, params } = insertStatement(table, row);
                prepare(sql).run(...params);
              }
              break;
            }
            case "sequence": {
              const updated = this.#db.run("UPDATE sqlite_sequence SET seq=? WHERE name=?", [
                change.value,
                change.name,
              ]);
              if (updated.changes === 0)
                this.#db.run("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", [
                  change.name,
                  change.value,
                ]);
              break;
            }
          }
        }
      }
      for (const trigger of wanted.values()) {
        if (trigger.tbl_name) {
          const exists = this.#db
            .query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?")
            .get(trigger.tbl_name);
          if (!exists) continue;
        }
        this.#db.exec(trigger.sql);
      }
      // Tables the replay created or redefined get their machinery; nothing is sent from here.
      this.#loadRegistry();
      const objects = this.#objects();
      const known = this.#known();
      const plan = this.#plan(objects, known);
      for (const name of plan.removed) this.#uninstall(name);
      for (const name of plan.resync) this.#instrument(name);
      this.#remember({ objects: this.#objects(), sequences: this.#sequences() });
    } finally {
      for (const statement of cache.values()) statement.finalize();
      this.#db.run("UPDATE _cdc_gate SET on_=1");
    }
    this.#schemaVersion = this.#version();
  }

  #specFor(specs: ReadonlyMap<string, TableSpec>, name: string): TableSpec {
    const spec = specs.get(name);
    if (!spec) throw new CaptureError(`The change set has no spec for ${name}`);
    return spec;
  }

  // ---- content hash -----------------------------------------------------------------------------

  /** A hash of everything replicated: the schema objects, every row of every replicated table in
   * key order, and the AUTOINCREMENT counters. Two databases with the same hash hold the same
   * book, whatever their files look like. */
  stateHash(): string {
    return this.stateDigest().overall;
  }

  /** The pieces {@link stateHash} is made of, so two databases that differ can say where: a hash of
   * the schema, a row count and a hash for every table, and a hash of the counters. */
  stateDigest(): StateDigest {
    const objects = this.#objects().sort((a, b) =>
      a.type === b.type ? (a.name < b.name ? -1 : 1) : a.type < b.type ? -1 : 1,
    );
    const encoder = new RowEncoder();
    const schema = createHash("sha256");
    for (const object of objects)
      schema.update(encoder.row([object.type, object.name, object.tbl, normalizeSql(object.sql)]));
    const names = objects
      .filter((object) => object.type === "table")
      .map((object) => object.name)
      .sort();
    const tables: Record<string, { rows: number; hash: string }> = {};
    for (const name of names) {
      const hash = createHash("sha256");
      const spec = this.#specOf(name, 0);
      hash.update(encoder.row(["table", name, ...spec.columns]));
      const order = spec.key.map((at) => q(spec.columns[at] as string)).join(", ");
      const columns = spec.columns.map((column) => selectColumn(spec, column)).join(", ");
      const statement = exact(
        this.#db.query(
          `SELECT ${columns} FROM ${q(name)} ORDER BY ${spec.rowid ? "rowid" : order}`,
        ),
      );
      let rows = 0;
      for (const row of statement.values() as SqlValue[][]) {
        hash.update(encoder.row(row));
        rows += 1;
      }
      statement.finalize();
      tables[name] = { rows, hash: hash.digest("hex") };
    }
    const counters = createHash("sha256");
    const sequences = this.#sequences();
    for (const name of Object.keys(sequences).sort())
      counters.update(encoder.row(["sequence", name, sequences[name] as string]));
    const schemaDigest = schema.digest("hex");
    const countersDigest = counters.digest("hex");
    const overall = createHash("sha256");
    overall.update(schemaDigest);
    for (const name of names) {
      const table = tables[name] as { rows: number; hash: string };
      overall.update(`\n${name}\n${table.rows}\n${table.hash}`);
    }
    overall.update(`\n${countersDigest}`);
    return {
      schema: schemaDigest,
      tables,
      sequences: countersDigest,
      overall: overall.digest("hex"),
    };
  }

  // ---- reading what was captured ---------------------------------------------------------------

  #version(): number {
    return (this.#db.query("PRAGMA schema_version").get() as { schema_version: number })
      .schema_version;
  }

  #readChanges(
    skipped: ReadonlySet<number>,
    out: Change[],
    spec: (name: string) => Spec,
  ): Set<number> {
    const byId = new Map<number, Spec>();
    for (const found of this.#tables.values()) byId.set(found.id, found);
    // A table sent whole has had its machinery rebuilt (the shadow rows are gone), and what was
    // captured for it is in the whole table anyway.
    const order = (
      this.#db.query("SELECT seq, t, op FROM _cdc ORDER BY seq").values() as number[][]
    ).filter((row) => !skipped.has(row[1] as number));
    const read = new Set<number>();
    if (order.length === 0) return read;
    // One pass over each shadow table, then merge in the order the changes happened.
    const queues = new Map<number, SqlValue[][]>();
    for (const id of new Set(order.map((row) => row[1] as number))) {
      const found = byId.get(id);
      if (!found) throw new CaptureError(`A change was captured for an unknown table (${id})`);
      const columns = [
        "seq",
        ...found.key.map((_, at) => `o${at}`),
        ...found.columns.map((_, at) => `c${at}`),
      ];
      const statement = exact(
        this.#db.query(`SELECT ${columns.join(", ")} FROM ${q(`_cdc_t${id}`)} ORDER BY seq`),
      );
      queues.set(id, statement.values() as SqlValue[][]);
      statement.finalize();
      read.add(id);
    }
    const cursor = new Map<number, number>();
    for (const [seq, tableId, op] of order as [number, number, number][]) {
      const found = byId.get(tableId) as Spec;
      const at = cursor.get(tableId) ?? 0;
      cursor.set(tableId, at + 1);
      const row = (queues.get(tableId) as SqlValue[][])[at];
      if (!row || Number(row[0]) !== seq)
        throw new CaptureError(`The shadow row for change ${seq} is missing`);
      spec(found.name);
      const oldKey = row.slice(1, 1 + found.key.length);
      const newRow = row.slice(1 + found.key.length);
      if (op === OP.insert) out.push({ op: "insert", table: found.name, row: newRow });
      else if (op === OP.update)
        out.push({ op: "update", table: found.name, key: oldKey, row: newRow });
      else out.push({ op: "delete", table: found.name, key: oldKey });
    }
    return read;
  }

  #readAll(spec: Spec): SqlValue[][] {
    const columns = spec.columns.map((column) => selectColumn(spec, column)).join(", ");
    const statement = exact(
      this.#db.query(
        `SELECT ${columns} FROM ${q(spec.name)} ORDER BY ${spec.rowid ? "rowid" : spec.key.map((at) => q(spec.columns[at] as string)).join(", ")}`,
      ),
    );
    const rows = statement.values() as SqlValue[][];
    statement.finalize();
    return rows;
  }

  #sequences(): Record<string, string> {
    const exists = this.#db.query("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get();
    if (!exists) return {};
    const result: Record<string, string> = {};
    const statement = exact(this.#db.query("SELECT name, seq FROM sqlite_sequence"));
    for (const [name, seq] of statement.values() as [string, bigint][])
      if (this.#tables.has(name) || this.#replicated(name)) result[name] = String(seq);
    statement.finalize();
    return result;
  }

  #replicated(name: string): boolean {
    return !internal(name) && !this.#exclude.has(name);
  }

  #clear(): void {
    this.#db.exec("DELETE FROM _cdc");
    for (const spec of this.#tables.values()) this.#db.exec(`DELETE FROM ${q(`_cdc_t${spec.id}`)}`);
  }

  // ---- schema ---------------------------------------------------------------------------------------

  #objects(): SchemaObject[] {
    const rows = this.#db
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid",
      )
      .all() as { type: SchemaObject["type"]; name: string; tbl_name: string; sql: string }[];
    const kept: SchemaObject[] = [];
    for (const row of rows) {
      if (internal(row.name) || internal(row.tbl_name) || this.#exclude.has(row.tbl_name)) continue;
      if (row.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql))
        throw new CaptureError(`The virtual table ${row.name} cannot be replicated`);
      kept.push({ type: row.type, name: row.name, tbl: row.tbl_name, sql: row.sql });
    }
    return kept;
  }

  /** The baseline, read from the file once and kept. */
  #known(): Baseline {
    if (!this.#baseline) {
      this.#baseline = this.#loadKnown();
      this.#sequencesText = JSON.stringify(this.#baseline.sequences);
    }
    return this.#baseline;
  }

  #loadKnown(): Baseline {
    const get = (key: string): string | null =>
      (this.#db.query("SELECT v FROM _cdc_state WHERE k=?").get(key) as { v: string } | null)?.v ??
      null;
    const stored = get("baseline");
    const counters = get("sequences");
    let objects: readonly SchemaObject[] = [];
    let sequences: Readonly<Record<string, string>> = {};
    if (stored) {
      const parsed = JSON.parse(stored) as
        | readonly SchemaObject[]
        | { objects: readonly SchemaObject[]; sequences?: Record<string, string> };
      if (Array.isArray(parsed)) objects = parsed;
      else {
        const legacy = parsed as {
          objects: readonly SchemaObject[];
          sequences?: Record<string, string>;
        };
        objects = legacy.objects;
        sequences = legacy.sequences ?? {};
      }
    }
    if (counters) sequences = JSON.parse(counters) as Record<string, string>;
    return { objects, sequences };
  }

  /** Record the schema and the counters as sent. The (large) schema is written only when it is not the
   * one already recorded; the counters, which move with every insert into an AUTOINCREMENT table, are
   * a key of their own. */
  #remember(baseline: Baseline): void {
    const cached = this.#baseline;
    if (!cached || cached.objects !== baseline.objects)
      this.#db.run(
        "INSERT INTO _cdc_state (k, v) VALUES ('baseline', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        [JSON.stringify(baseline.objects)],
      );
    const text = JSON.stringify(baseline.sequences);
    if (!cached || text !== this.#sequencesText)
      this.#db.run(
        "INSERT INTO _cdc_state (k, v) VALUES ('sequences', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        [text],
      );
    this.#baseline = baseline;
    this.#sequencesText = text;
  }

  #loadRegistry(): Map<string, Spec> {
    this.#tables = new Map();
    for (const row of this.#db.query("SELECT id, name, spec FROM _cdc_tables").all() as {
      id: number;
      name: string;
      spec: string;
    }[])
      this.#tables.set(row.name, { ...(JSON.parse(row.spec) as Spec), id: row.id });
    return this.#tables;
  }

  /** What changed in the schema since the baseline, as statements to send and tables to send whole. */
  #plan(
    objects: readonly SchemaObject[],
    known: Baseline,
  ): { ddl: string[]; resync: Set<string>; removed: string[] } {
    const before = new Map(
      known.objects.map((object) => [`${object.type}:${object.name}`, object] as const),
    );
    const after = new Map(
      objects.map((object) => [`${object.type}:${object.name}`, object] as const),
    );
    const triggers = new Set(
      (
        this.#db
          .query(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '\\_cdc\\_%' ESCAPE '\\'",
          )
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    const shadows = new Set(
      (
        this.#db
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\\_cdc\\_t%' ESCAPE '\\'",
          )
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    const ddl: string[] = [];
    const resync = new Set<string>();
    const removed: string[] = [];
    const redefined = new Set<string>();

    // Tables first: new, redefined, repaired or gone.
    for (const object of objects) {
      if (object.type !== "table") continue;
      const old = before.get(`table:${object.name}`);
      const registered = this.#tables.get(object.name);
      const intact =
        registered !== undefined &&
        triggers.has(`_cdc_i${registered.id}`) &&
        triggers.has(`_cdc_u${registered.id}`) &&
        triggers.has(`_cdc_d${registered.id}`) &&
        shadows.has(`_cdc_t${registered.id}`);
      if (!old) {
        ddl.push(object.sql);
        resync.add(object.name);
      } else if (normalizeSql(old.sql) !== normalizeSql(object.sql)) {
        const added = addedColumn(old.sql, object.sql);
        if (added) ddl.push(`ALTER TABLE ${q(object.name)} ADD COLUMN ${added}`);
        else {
          ddl.push(`DROP TABLE ${q(object.name)}`, object.sql);
          redefined.add(object.name);
        }
        resync.add(object.name);
      } else if (!intact || !this.#sameSpec(object.name)) {
        resync.add(object.name);
      }
    }
    for (const old of known.objects) {
      if (old.type === "table" && !after.has(`table:${old.name}`)) {
        ddl.push(`DROP TABLE IF EXISTS ${q(old.name)}`);
        removed.push(old.name);
      }
    }
    // Everything else is carried as DDL: a new object as it is, a changed one dropped and made again,
    // and the indexes and triggers of a table that was dropped and made again, made again.
    for (const object of objects) {
      if (object.type === "table") continue;
      const old = before.get(`${object.type}:${object.name}`);
      const rebuilt = redefined.has(object.tbl);
      if (!old) ddl.push(object.sql);
      else if (normalizeSql(old.sql) !== normalizeSql(object.sql) || rebuilt) {
        ddl.push(`DROP ${object.type.toUpperCase()} IF EXISTS ${q(object.name)}`, object.sql);
      }
    }
    for (const old of known.objects) {
      if (old.type === "table" || after.has(`${old.type}:${old.name}`)) continue;
      if (removed.includes(old.tbl) || redefined.has(old.tbl)) continue; // went with its table
      ddl.push(`DROP ${old.type.toUpperCase()} IF EXISTS ${q(old.name)}`);
    }
    return { ddl, resync, removed };
  }

  #sameSpec(name: string): boolean {
    const registered = this.#tables.get(name);
    if (!registered) return false;
    const fresh = this.#specOf(name, registered.id);
    return (
      JSON.stringify([fresh.columns, fresh.key, fresh.rowid]) ===
      JSON.stringify([registered.columns, registered.key, registered.rowid])
    );
  }

  #specOf(name: string, id: number): Spec {
    const info = this.#db.query(`PRAGMA table_xinfo(${q(name)})`).all() as {
      cid: number;
      name: string;
      type: string;
      pk: number;
      hidden: number;
    }[];
    const real = info.filter((column) => column.hidden === 0);
    const keyColumns = real.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
    const listed = this.#db
      .query("SELECT wr FROM pragma_table_list WHERE name=? AND schema='main'")
      .get(name) as { wr: number } | null;
    const withoutRowid = listed?.wr === 1;
    const sql = (
      this.#db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as {
        sql: string;
      }
    ).sql;
    const alias =
      !withoutRowid &&
      keyColumns.length === 1 &&
      (keyColumns[0] as { type: string }).type.trim().toUpperCase() === "INTEGER";
    const names = real.map((column) => column.name);
    if (withoutRowid || alias) {
      if (keyColumns.length === 0) throw new CaptureError(`The table ${name} has no key`);
      return {
        id,
        name,
        columns: names,
        key: keyColumns.map((column) => names.indexOf(column.name)),
        rowid: false,
        withoutRowid,
        autoincrement: /\bAUTOINCREMENT\b/i.test(sql),
      };
    }
    // A rowid table whose key is not the rowid: the rowid itself identifies the row, and travels
    // with it so a replica scans in the same order.
    return {
      id,
      name,
      columns: ["rowid", ...names],
      key: [0],
      rowid: true,
      withoutRowid: false,
      autoincrement: /\bAUTOINCREMENT\b/i.test(sql),
    };
  }

  /** Create (or recreate) the shadow table and the three triggers for a table. */
  #instrument(name: string): void {
    const existing = this.#tables.get(name);
    const id = existing?.id ?? this.#nextId();
    const spec = this.#specOf(name, id);
    for (const prefix of ["i", "u", "d"])
      this.#db.exec(`DROP TRIGGER IF EXISTS ${q(`_cdc_${prefix}${id}`)}`);
    this.#db.exec(`DROP TABLE IF EXISTS ${q(`_cdc_t${id}`)}`);
    const shadowColumns = [
      "seq INTEGER PRIMARY KEY",
      ...spec.key.map((_, at) => `o${at}`),
      ...spec.columns.map((_, at) => `c${at}`),
    ];
    this.#db.exec(`CREATE TABLE ${q(`_cdc_t${id}`)} (${shadowColumns.join(", ")})`);
    const ref = (side: "NEW" | "OLD", column: string) =>
      spec.rowid && column === "rowid" ? `${side}.rowid` : `${side}.${q(column)}`;
    const newRow = spec.columns.map((column) => ref("NEW", column));
    const oldKey = spec.key.map((at) => ref("OLD", spec.columns[at] as string));
    const names = (list: readonly unknown[], prefix: string) =>
      list.map((_, at) => `${prefix}${at}`);
    const gate = "WHEN (SELECT on_ FROM _cdc_gate) = 1";
    const shadow = q(`_cdc_t${id}`);
    const table = q(name);
    this.#db.exec(
      `CREATE TRIGGER ${q(`_cdc_i${id}`)} AFTER INSERT ON ${table} ${gate} BEGIN
         INSERT INTO _cdc (t, op) VALUES (${id}, ${OP.insert});
         INSERT INTO ${shadow} (seq, ${names(newRow, "c").join(", ")}) VALUES (last_insert_rowid(), ${newRow.join(", ")});
       END`,
    );
    this.#db.exec(
      `CREATE TRIGGER ${q(`_cdc_u${id}`)} AFTER UPDATE ON ${table} ${gate} BEGIN
         INSERT INTO _cdc (t, op) VALUES (${id}, ${OP.update});
         INSERT INTO ${shadow} (seq, ${names(oldKey, "o").join(", ")}, ${names(newRow, "c").join(", ")})
           VALUES (last_insert_rowid(), ${oldKey.join(", ")}, ${newRow.join(", ")});
       END`,
    );
    this.#db.exec(
      `CREATE TRIGGER ${q(`_cdc_d${id}`)} AFTER DELETE ON ${table} ${gate} BEGIN
         INSERT INTO _cdc (t, op) VALUES (${id}, ${OP.delete});
         INSERT INTO ${shadow} (seq, ${names(oldKey, "o").join(", ")}) VALUES (last_insert_rowid(), ${oldKey.join(", ")});
       END`,
    );
    this.#db.run(
      "INSERT INTO _cdc_tables (id, name, spec) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET spec=excluded.spec, name=excluded.name",
      [id, name, JSON.stringify(spec)],
    );
    this.#tables.set(name, spec);
  }

  #uninstall(name: string): void {
    const spec = this.#tables.get(name);
    if (!spec) return;
    this.#db.exec(`DROP TABLE IF EXISTS ${q(`_cdc_t${spec.id}`)}`);
    this.#db.run("DELETE FROM _cdc_tables WHERE id=?", [spec.id]);
    this.#tables.delete(name);
  }

  #nextId(): number {
    const row = this.#db
      .query("SELECT COALESCE(MAX(id), 0) + 1 AS next FROM _cdc_tables")
      .get() as { next: number };
    // Ids are never reused within a database file's life while a table is registered.
    let id = row.next;
    for (const spec of this.#tables.values()) id = Math.max(id, spec.id + 1);
    return id;
  }
}

// ---- statements for replay ---------------------------------------------------------------------

const columnRef = (table: TableSpec & { rowid?: boolean }, column: string): string =>
  column === "rowid" && (table as { rowid?: boolean }).rowid ? "rowid" : q(column);

function holder(value: SqlValue): string {
  return typeof value === "number" ? "CAST(? AS REAL)" : "?";
}
function bind(value: SqlValue): string | bigint | number | Uint8Array | null {
  return value;
}

function insertStatement(
  table: TableSpec,
  row: readonly SqlValue[],
): { sql: string; params: (string | bigint | number | Uint8Array | null)[] } {
  const names = table.columns.map((column) => columnRef(withRowid(table), column));
  return {
    sql: `INSERT INTO ${q(table.name)} (${names.join(", ")}) VALUES (${row.map(holder).join(", ")})`,
    params: row.map(bind),
  };
}

function updateStatement(
  table: TableSpec,
  key: readonly SqlValue[],
  row: readonly SqlValue[],
): { sql: string; params: (string | bigint | number | Uint8Array | null)[] } {
  const spec = withRowid(table);
  const set = table.columns.map(
    (column, at) => `${columnRef(spec, column)} = ${holder(row[at] as SqlValue)}`,
  );
  const where = table.key.map(
    (at, position) =>
      `${columnRef(spec, table.columns[at] as string)} = ${holder(key[position] as SqlValue)}`,
  );
  return {
    sql: `UPDATE ${q(table.name)} SET ${set.join(", ")} WHERE ${where.join(" AND ")}`,
    params: [...row.map(bind), ...key.map(bind)],
  };
}

function deleteStatement(
  table: TableSpec,
  key: readonly SqlValue[],
): { sql: string; params: (string | bigint | number | Uint8Array | null)[] } {
  const spec = withRowid(table);
  const where = table.key.map(
    (at, position) =>
      `${columnRef(spec, table.columns[at] as string)} = ${holder(key[position] as SqlValue)}`,
  );
  return {
    sql: `DELETE FROM ${q(table.name)} WHERE ${where.join(" AND ")}`,
    params: key.map(bind),
  };
}

/** A spec from a change set does not say whether its first column is the implicit rowid; that is
 * the one column named "rowid" the table does not declare, which replay discovers when it asks. */
function withRowid(table: TableSpec): TableSpec & { rowid: boolean } {
  return {
    ...table,
    rowid: table.columns[0] === "rowid" && table.key.length === 1 && table.key[0] === 0,
  };
}

function selectColumn(spec: Spec, column: string): string {
  return spec.rowid && column === "rowid" ? "rowid" : q(column);
}

const unquote = (name: string): string =>
  name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;

/** SQLite keeps the text of a CREATE statement as written; compare it without the whitespace
 * differences a rewrite (ALTER TABLE ... ADD COLUMN) can introduce. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** If `after` is `before` with exactly one column definition added at the end of the column list
 * (what ALTER TABLE ... ADD COLUMN does to the stored text), the definition; else null. */
export function addedColumn(before: string, after: string): string | null {
  const a = normalizeSql(before);
  const b = normalizeSql(after);
  if (b.length <= a.length) return null;
  let common = 0;
  while (common < a.length && a[common] === b[common]) common += 1;
  // The text after the insertion point is the same in both (the closing parenthesis and any options).
  const tail = a.slice(common);
  if (!b.endsWith(tail)) return null;
  const middle = b.slice(common, b.length - tail.length);
  if (!middle.startsWith(", ")) return null;
  const definition = middle.slice(2);
  // A single definition has no top-level comma.
  let depth = 0;
  for (const char of definition) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) return null;
  }
  return definition.length > 0 ? definition : null;
}

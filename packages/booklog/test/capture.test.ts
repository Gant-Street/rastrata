import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { decodeChangeSet, encodeChangeSet } from "../src/codec.ts";
import { ChangeCapture, addedColumn, type Pending } from "../src/capture.ts";
import { Rng } from "../src/rng.ts";

const EXCLUDE = ["derived"];

function open(options: { schema?: string; foreignKeys?: boolean } = {}) {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  if (options.foreignKeys !== false) db.exec("PRAGMA foreign_keys=ON");
  if (options.schema) db.exec(options.schema);
  const capture = new ChangeCapture(db, { exclude: EXCLUDE });
  capture.install();
  return { db, capture };
}

type World = ReturnType<typeof open>;

/** What a request end does: peek inside the transaction, through the wire format, settle. */
function commit(source: World, work: (db: Database) => void): Pending | null {
  source.db.exec("BEGIN IMMEDIATE");
  try {
    work(source.db);
    const pending = source.capture.peek();
    if (pending) source.capture.settle(pending);
    source.db.exec("COMMIT");
    return pending;
  } catch (error) {
    source.db.exec("ROLLBACK");
    throw error;
  }
}

/** Replay on a replica the way a catch-up does: foreign keys off, one transaction. */
function replay(replica: World, pending: Pending | null) {
  if (!pending) return;
  const wire = decodeChangeSet(encodeChangeSet(pending.set));
  replica.db.exec("PRAGMA foreign_keys=OFF");
  replica.db.exec("BEGIN IMMEDIATE");
  try {
    replica.capture.apply(wire);
    replica.db.exec("COMMIT");
  } catch (error) {
    replica.db.exec("ROLLBACK");
    throw error;
  } finally {
    replica.db.exec("PRAGMA foreign_keys=ON");
  }
}

function same(a: World, b: World) {
  expect(b.capture.stateHash()).toBe(a.capture.stateHash());
}

const SCHEMA = `
  CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT UNIQUE, note TEXT);
  CREATE TABLE child (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE, label TEXT, qty REAL, data BLOB);
  CREATE TABLE kv (k TEXT PRIMARY KEY, v);
  CREATE TABLE pair (a TEXT, b INTEGER, payload TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
  CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT);
  CREATE TABLE derived (k TEXT PRIMARY KEY, v);
  CREATE INDEX child_label ON child (label);
  CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN INSERT INTO audit (what) VALUES ('child ' || NEW.id); END;
`;

describe("capture and replay", () => {
  test("the first change set is the whole database; later ones are only the changes", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    source.db.run("INSERT INTO parent (id, name, note) VALUES (1, 'a', 'first')");
    const genesis = commit(source, () => {});
    expect(genesis).not.toBeNull();
    expect([...(genesis?.resynced ?? [])].sort()).toEqual([
      "audit",
      "child",
      "kv",
      "pair",
      "parent",
    ]);
    expect(genesis?.ddl).toBeGreaterThan(5);
    replay(replica, genesis);
    same(source, replica);

    const next = commit(source, (db) => {
      db.run("INSERT INTO parent (id, name, note) VALUES (2, 'b', 'second')");
      db.run("UPDATE parent SET note = 'changed' WHERE id = 1");
    });
    expect(next?.set.changes.map((change) => change.op)).toEqual(["insert", "update"]);
    expect(next?.resynced).toEqual([]);
    replay(replica, next);
    same(source, replica);
    expect(commit(source, () => {})).toBeNull();
  });

  test("every kind of value arrives as the kind it was", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    const big = 9007199254740993n;
    const blob = new Uint8Array([0, 1, 2, 255, 0, 7]);
    const next = commit(source, (db) => {
      db.run("INSERT INTO kv (k, v) VALUES ('int', ?)", [big]);
      db.run("INSERT INTO kv (k, v) VALUES ('neg', ?)", [-9223372036854775808n]);
      db.run("INSERT INTO kv (k, v) VALUES ('real5', 5.0)");
      db.run("INSERT INTO kv (k, v) VALUES ('real', ?)", [0.1 + 0.2]);
      db.run("INSERT INTO kv (k, v) VALUES ('huge', ?)", [1e300]);
      db.run("INSERT INTO kv (k, v) VALUES ('inf', ?)", [Number.POSITIVE_INFINITY]);
      db.run("INSERT INTO kv (k, v) VALUES ('text', ?)", ['it\'s "quoted" é 日本 \u{1F600}']);
      db.run("INSERT INTO kv (k, v) VALUES ('json', ?)", ['{"a":[1,2,{"b":null}],"c":"d"}']);
      db.run("INSERT INTO kv (k, v) VALUES ('blob', ?)", [blob]);
      db.run("INSERT INTO kv (k, v) VALUES ('empty', ?)", [new Uint8Array(0)]);
      db.run("INSERT INTO kv (k, v) VALUES ('null', NULL)");
      db.run("INSERT INTO kv (k, v) VALUES ('emptytext', '')");
    });
    replay(replica, next);
    same(source, replica);
    const types = (w: World) =>
      w.db
        .query("SELECT k, typeof(v) t FROM kv ORDER BY k")
        .values()
        .map((row) => row.join("="));
    expect(types(replica)).toEqual(types(source));
    expect(types(replica)).toContain("real5=real");
    expect(types(replica)).toContain("int=integer");
    const back = replica.db.query("SELECT v FROM kv WHERE k='int'").get() as { v: number };
    expect(String(back.v)).not.toBe("");
    expect(
      (replica.db.query("SELECT v, typeof(v) t FROM kv WHERE k='blob'").get() as { v: Uint8Array })
        .v,
    ).toEqual(blob);
  });

  test("a rolled-back request leaves nothing, and so does a rolled-back savepoint", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    expect(() =>
      commit(source, (db) => {
        db.run("INSERT INTO parent (id, name) VALUES (1, 'gone')");
        throw new Error("the request failed");
      }),
    ).toThrow("the request failed");
    expect(source.capture.dirty).toBe(false);
    const partial = commit(source, (db) => {
      db.run("INSERT INTO parent (id, name) VALUES (1, 'kept')");
      db.exec("SAVEPOINT inner");
      db.run("INSERT INTO parent (id, name) VALUES (2, 'undone')");
      db.run("UPDATE parent SET note = 'x' WHERE id = 1");
      db.exec("ROLLBACK TO inner");
      db.exec("RELEASE inner");
      db.run("INSERT INTO parent (id, name) VALUES (3, 'also kept')");
    });
    expect(partial?.set.changes).toHaveLength(2);
    replay(replica, partial);
    same(source, replica);
    expect(replica.db.query("SELECT count(*) c FROM parent").get()).toEqual({ c: 2 });
  });

  test("keys: a text key keeps its rowid, a composite key without rowid, a key that changes", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    const next = commit(source, (db) => {
      db.run("INSERT INTO kv (k, v) VALUES ('z', 1), ('a', 2), ('m', 3)");
      db.run("DELETE FROM kv WHERE k = 'a'");
      db.run("INSERT INTO kv (k, v) VALUES ('b', 4)");
      db.run("UPDATE kv SET k = 'zz' WHERE k = 'z'");
      db.run("INSERT INTO pair (a, b, payload) VALUES ('x', 1, 'p'), ('x', 2, 'q'), ('y', 1, 'r')");
      db.run("UPDATE pair SET b = 9 WHERE a = 'x' AND b = 1");
      db.run("DELETE FROM pair WHERE a = 'y'");
    });
    replay(replica, next);
    same(source, replica);
    const rowids = (w: World) =>
      w.db
        .query("SELECT rowid, k FROM kv ORDER BY rowid")
        .values()
        .map((row) => row.join(":"));
    expect(rowids(replica)).toEqual(rowids(source));
    const scan = (w: World) =>
      w.db
        .query("SELECT k FROM kv")
        .values()
        .map((row) => String(row[0]));
    expect(scan(replica)).toEqual(scan(source));
  });

  test("REPLACE, upsert, OR IGNORE, cascades and AUTOINCREMENT counters replay exactly", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    const first = commit(source, (db) => {
      db.run(
        "INSERT INTO parent (id, name, note) VALUES (1, 'a', 'x'), (2, 'b', 'y'), (3, 'c', 'z')",
      );
      db.run(
        "INSERT INTO child (parent_id, label, qty) VALUES (1, 'one', 1.5), (1, 'two', 2.0), (2, 'three', 3.25)",
      );
      db.run("INSERT INTO child (parent_id, label) VALUES (3, 'four')");
    });
    replay(replica, first);
    same(source, replica);
    const second = commit(source, (db) => {
      db.run(
        "INSERT OR REPLACE INTO parent (id, name, note) VALUES (4, 'a', 'replaced a by name')",
      );
      db.run(
        "INSERT INTO parent (id, name, note) VALUES (2, 'b2', 'upsert') ON CONFLICT(id) DO UPDATE SET name = excluded.name, note = excluded.note",
      );
      db.run("INSERT OR IGNORE INTO parent (id, name) VALUES (3, 'ignored')");
      db.run("DELETE FROM parent WHERE id = 3");
      db.run("DELETE FROM child WHERE label = 'two'");
    });
    replay(replica, second);
    same(source, replica);
    // The counter behind AUTOINCREMENT, including the numbers burned by deletes.
    const counters = (w: World) =>
      w.db.query("SELECT name, seq FROM sqlite_sequence ORDER BY name").values();
    expect(counters(replica)).toEqual(counters(source));
    // A replica that takes over carries on from the same number.
    const next = (w: World) => {
      w.db.run("INSERT INTO child (parent_id, label) VALUES (4, 'after')");
      return (w.db.query("SELECT max(id) m FROM child").get() as { m: number }).m;
    };
    expect(next(replica)).toBe(next(source));
  });

  test("a trigger of the application is not run again on a replica: its effects are in the change set", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    const next = commit(source, (db) => {
      db.run("INSERT INTO parent (id, name) VALUES (1, 'p')");
      db.run("INSERT INTO child (parent_id, label) VALUES (1, 'c')");
    });
    // The audit row the trigger wrote is a change of its own.
    expect(
      next?.set.changes.filter((change) => change.op === "insert").map((change) => change.table),
    ).toEqual(["parent", "child", "audit"]);
    replay(replica, next);
    same(source, replica);
    expect(replica.db.query("SELECT count(*) c FROM audit").get()).toEqual({ c: 1 });
    // And it is back in place afterwards, for the replica's own writes.
    commit(replica, (db) => db.run("INSERT INTO child (parent_id, label) VALUES (1, 'd')"));
    expect(replica.db.query("SELECT count(*) c FROM audit").get()).toEqual({ c: 2 });
  });

  test("tables that are derived are neither captured nor compared", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    replica.db.exec("CREATE TABLE derived (k TEXT PRIMARY KEY, v)");
    const outcome = commit(source, (db) =>
      db.run("INSERT INTO derived (k, v) VALUES ('cache', 'x')"),
    );
    expect(outcome).toBeNull();
    commit(replica, (db) => db.run("INSERT INTO derived (k, v) VALUES ('other cache', 'y')"));
    same(source, replica);
  });

  test("replaying switches capture off: the replica has nothing pending afterwards", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    replay(
      replica,
      commit(source, (db) => db.run("INSERT INTO parent (id, name) VALUES (1, 'p')")),
    );
    expect(replica.capture.dirty).toBe(false);
    expect(replica.capture.peek()).toBeNull();
    // And it captures its own writes again.
    const own = commit(replica, (db) => db.run("INSERT INTO parent (id, name) VALUES (2, 'q')"));
    expect(own?.count).toBe(1);
  });

  test("a change that cannot be applied rolls the replica back whole", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    const pending = commit(source, (db) => {
      db.run("INSERT INTO parent (id, name) VALUES (1, 'p')");
      db.run("INSERT INTO parent (id, name) VALUES (2, 'q')");
    });
    commit(replica, (db) => db.run("DELETE FROM parent"));
    const damaged = {
      ...pending,
      set: {
        tables: pending?.set.tables ?? [],
        changes: [
          ...(pending?.set.changes ?? []),
          { op: "delete" as const, table: "parent", key: [99n] },
        ],
      },
    } as Pending;
    expect(() => replay(replica, damaged)).toThrow(/was not there/);
    expect(replica.db.query("SELECT count(*) c FROM parent").get()).toEqual({ c: 0 });
    expect(replica.capture.dirty).toBe(false);
  });

  test("schema: new tables arrive whole, columns arrive as ALTERs, indexes, views and triggers as DDL", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    const first = commit(source, (db) => {
      db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
      db.run("INSERT INTO notes (id, body) VALUES (1, 'before the column')");
      db.exec("ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
      db.run("UPDATE notes SET pinned = 1 WHERE id = 1");
      db.run("INSERT INTO notes (id, body, pinned) VALUES (2, 'after', 1)");
      db.exec("CREATE INDEX notes_body ON notes (body)");
      db.exec("CREATE VIEW pinned_notes AS SELECT id, body FROM notes WHERE pinned = 1");
    });
    expect(first?.resynced).toEqual(["notes"]);
    replay(replica, first);
    same(source, replica);

    // A column added to a table that already exists, with changes to it in the same request.
    const second = commit(source, (db) => {
      db.run("INSERT INTO parent (id, name) VALUES (1, 'p')");
      db.exec("ALTER TABLE parent ADD COLUMN extra TEXT DEFAULT 'none'");
      db.run("UPDATE parent SET extra = 'set' WHERE id = 1");
      db.run("INSERT INTO parent (id, name, extra) VALUES (2, 'q', 'new')");
    });
    expect(
      second?.set.changes.some((change) => change.op === "ddl" && /ADD COLUMN/.test(change.sql)),
    ).toBe(true);
    replay(replica, second);
    same(source, replica);
    // Later changes to it are ordinary ones again, with the new column.
    const third = commit(source, (db) => db.run("UPDATE parent SET extra = 'later' WHERE id = 2"));
    expect(third?.resynced).toEqual([]);
    expect(third?.set.tables[0]?.columns).toContain("extra");
    replay(replica, third);
    same(source, replica);

    // A trigger made, and one dropped.
    const fourth = commit(source, (db) => {
      db.exec(
        "CREATE TRIGGER note_audit AFTER INSERT ON notes BEGIN INSERT INTO audit (what) VALUES ('note'); END",
      );
      db.exec("DROP TRIGGER child_audit");
    });
    replay(replica, fourth);
    same(source, replica);
    commit(replica, (db) => db.run("INSERT INTO notes (id, body) VALUES (9, 'x')"));
    expect(replica.db.query("SELECT count(*) c FROM audit WHERE what = 'note'").get()).toEqual({
      c: 1,
    });
    commit(replica, (db) => {
      db.run("INSERT INTO parent (id, name) VALUES (7, 'r')");
      db.run("INSERT INTO child (parent_id, label) VALUES (7, 'no audit now')");
    });
    expect(replica.db.query("SELECT count(*) c FROM audit WHERE what LIKE 'child%'").get()).toEqual(
      { c: 0 },
    );
  });

  test("a table dropped and made again, and one dropped for good", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    replay(
      replica,
      commit(source, (db) => db.run("INSERT INTO kv (k, v) VALUES ('a', 1), ('b', 2)")),
    );
    const second = commit(source, (db) => {
      db.exec("DROP TABLE kv");
      db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v, extra INTEGER)");
      db.run("INSERT INTO kv (k, v, extra) VALUES ('c', 3, 30)");
      db.exec("DROP TABLE pair");
    });
    replay(replica, second);
    same(source, replica);
    // The recreated table is captured as before.
    const third = commit(source, (db) => db.run("UPDATE kv SET v = 4 WHERE k = 'c'"));
    expect(third?.resynced).toEqual([]);
    replay(replica, third);
    same(source, replica);
  });

  test("rows changed in a table that is dropped in the same request are not read back", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    replay(
      replica,
      commit(source, (db) => db.run("INSERT INTO pair (a, b, payload) VALUES ('x', 1, 'p')")),
    );
    const dropped = commit(source, (db) => {
      db.run("INSERT INTO pair (a, b, payload) VALUES ('y', 2, 'q')");
      db.run("UPDATE pair SET payload = 'z' WHERE a = 'x'");
      db.exec("DROP TABLE pair");
      db.run("INSERT INTO kv (k, v) VALUES ('after', 1)");
    });
    replay(replica, dropped);
    same(source, replica);
    expect(replica.db.query("SELECT name FROM sqlite_master WHERE name='pair'").get()).toBeNull();
    expect(source.capture.hasUnsent()).toBe(false);
  });

  test("a change made after the peek and before the settle is kept for the next entry", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    source.db.exec("BEGIN IMMEDIATE");
    source.db.run("INSERT INTO kv (k, v) VALUES ('one', 1)");
    const pending = source.capture.peek();
    // While the entry is on its way to the tail, something else writes to the database.
    source.db.run("INSERT INTO kv (k, v) VALUES ('late', 2)");
    source.capture.settle(pending as Pending);
    source.db.exec("COMMIT");
    replay(replica, pending);
    expect(source.capture.hasUnsent()).toBe(true);
    const next = commit(source, () => {});
    expect(next?.set.changes).toHaveLength(1);
    expect(next?.set.changes[0]).toMatchObject({ op: "insert", table: "kv" });
    const late = next?.set.changes[0] as { row: unknown[] } | undefined;
    expect(late?.row).toContain("late");
    replay(replica, next);
    same(source, replica);
    expect(source.capture.hasUnsent()).toBe(false);
  });

  test("a table made again with the same definition, its triggers lost, is repaired and sent whole", () => {
    const source = open({ schema: SCHEMA });
    const replica = open();
    replay(
      replica,
      commit(source, () => {}),
    );
    const second = commit(source, (db) => {
      db.exec("DROP TABLE kv");
      db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v)");
      db.run("INSERT INTO kv (k, v) VALUES ('only', 1)");
    });
    expect(second?.resynced).toContain("kv");
    replay(replica, second);
    same(source, replica);
  });

  test("column additions are told apart from other changes to a definition", () => {
    expect(
      addedColumn(
        "CREATE TABLE t (a INTEGER, b TEXT)",
        "CREATE TABLE t (a INTEGER, b TEXT, c TEXT DEFAULT 'x')",
      ),
    ).toBe("c TEXT DEFAULT 'x'");
    expect(
      addedColumn(
        "CREATE TABLE t (a INTEGER, b TEXT)",
        "CREATE TABLE t (a INTEGER, b TEXT, c TEXT, d TEXT)",
      ),
    ).toBeNull();
    expect(addedColumn("CREATE TABLE t (a INTEGER)", "CREATE TABLE t (a TEXT)")).toBeNull();
    expect(addedColumn("CREATE TABLE t (a INTEGER)", "CREATE TABLE t (a INTEGER)")).toBeNull();
    expect(
      addedColumn(
        "CREATE TABLE t (a INTEGER) WITHOUT ROWID",
        "CREATE TABLE t (a INTEGER, b CHECK (b IN (1, 2))) WITHOUT ROWID",
      ),
    ).toBe("b CHECK (b IN (1, 2))");
  });
});

describe("the content hash", () => {
  test("it differs when any value, type, key order or schema object differs, and not otherwise", () => {
    const a = open({ schema: SCHEMA });
    const b = open({ schema: SCHEMA });
    expect(a.capture.stateHash()).toBe(b.capture.stateHash());
    a.db.run("INSERT INTO kv (k, v) VALUES ('x', 1)");
    expect(a.capture.stateHash()).not.toBe(b.capture.stateHash());
    b.db.run("INSERT INTO kv (k, v) VALUES ('x', 1.0)");
    expect(a.capture.stateHash()).not.toBe(b.capture.stateHash());
    b.db.run("UPDATE kv SET v = 1 WHERE k = 'x'");
    expect(a.capture.stateHash()).toBe(b.capture.stateHash());
    a.db.exec("CREATE INDEX kv_v ON kv (v)");
    expect(a.capture.stateHash()).not.toBe(b.capture.stateHash());
    b.db.exec("CREATE INDEX kv_v ON kv (v)");
    expect(a.capture.stateHash()).toBe(b.capture.stateHash());
    // Derived tables do not count.
    a.db.run("INSERT INTO derived (k, v) VALUES ('c', 1)");
    expect(a.capture.stateHash()).toBe(b.capture.stateHash());
  });
});

describe("a long random history", () => {
  const letters = "abcdefghij";
  /** Changes to the schema a history can hold on its way: a table made, a trigger on it, a trigger dropped, the table
   * dropped (its trigger goes with it, with no statement of its own) and made again without one. */
  const SCHEMA_STEPS = [
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
    "CREATE TRIGGER note_audit AFTER INSERT ON notes BEGIN INSERT INTO audit (what) VALUES ('note'); END",
    "INSERT INTO notes (body) VALUES ('first')",
    "DROP TRIGGER child_audit",
    "DROP TABLE notes",
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, extra TEXT)",
    "INSERT INTO notes (body, extra) VALUES ('second', 'x')",
    "CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN INSERT INTO audit (what) VALUES ('child again ' || NEW.id); END",
  ];
  function history(seed: number, steps: number, kept?: (Pending | null)[]) {
    const rng = new Rng(seed);
    const source = open({ schema: SCHEMA });
    const replica = open();
    const first = commit(source, () => {});
    kept?.push(first);
    replay(replica, first);
    const schemaSteps = kept ? [...SCHEMA_STEPS] : [];
    const word = () => letters[rng.int(letters.length)] as string;
    const pick = (table: string, column: string): number | string | null => {
      const rows = source.db
        .query(`SELECT ${column} v FROM ${table} ORDER BY random() LIMIT 1`)
        .get() as {
        v: number | string;
      } | null;
      return rows?.v ?? null;
    };
    const statement = (db: Database) => {
      const dice = rng.int(26);
      if (dice < 3)
        db.run("INSERT OR IGNORE INTO parent (id, name, note) VALUES (?, ?, ?)", [
          rng.int(30),
          `${word()}${rng.int(9)}`,
          word(),
        ]);
      else if (dice < 5)
        db.run("INSERT OR REPLACE INTO parent (id, name, note) VALUES (?, ?, ?)", [
          rng.int(30),
          `${word()}${rng.int(9)}`,
          word(),
        ]);
      else if (dice < 6)
        db.run("UPDATE parent SET name = ? WHERE id = ?", [
          `${word()}${rng.int(9)}`,
          pick("parent", "id"),
        ]);
      else if (dice < 8) db.run("DELETE FROM parent WHERE id = ?", [pick("parent", "id")]);
      else if (dice < 12) {
        const parent = pick("parent", "id");
        if (parent !== null)
          db.run("INSERT INTO child (parent_id, label, qty, data) VALUES (?, ?, ?, ?)", [
            parent,
            word(),
            rng.chance(0.5) ? rng.next() * 100 : Math.floor(rng.next() * 50),
            rng.chance(0.3) ? new Uint8Array([rng.int(256), 0, rng.int(256)]) : null,
          ]);
      } else if (dice < 14)
        db.run("UPDATE child SET qty = ?, label = ? WHERE id = ?", [
          rng.next(),
          word(),
          pick("child", "id"),
        ]);
      else if (dice < 15) db.run("DELETE FROM child WHERE id = ?", [pick("child", "id")]);
      else if (dice < 17)
        db.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [
          `${word()}${rng.int(12)}`,
          rng.chance(0.5) ? BigInt(rng.int(1e9)) * 1000n : word(),
        ]);
      else if (dice < 18)
        db.run("UPDATE kv SET k = ? WHERE k = ?", [`${word()}${rng.int(12)}`, pick("kv", "k")]);
      else if (dice < 19) db.run("DELETE FROM kv WHERE k = ?", [pick("kv", "k")]);
      else if (dice < 22)
        db.run("INSERT OR REPLACE INTO pair (a, b, payload) VALUES (?, ?, ?)", [
          word(),
          rng.int(4),
          word(),
        ]);
      else if (dice < 23) db.run("DELETE FROM pair WHERE a = ?", [word()]);
      else if (dice < 24)
        db.run(
          "INSERT INTO derived (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
          [word(), rng.int(100)],
        );
      else db.run("UPDATE pair SET b = b + 10 WHERE a = ? AND b < 5", [word()]);
    };
    let rolledBack = 0;
    let requests = 0;
    for (let step = 0; step < steps; step += 1) {
      if (step % 37 === 20 && schemaSteps.length > 0) {
        const sql = schemaSteps.shift() as string;
        const pending = commit(source, (db) => db.exec(sql));
        kept?.push(pending);
        replay(replica, pending);
      }
      const doomed = rng.chance(0.12);
      try {
        const pending = commit(source, (db) => {
          const count = 1 + rng.int(6);
          for (let index = 0; index < count; index += 1) {
            // a constraint the generator ran into (a UNIQUE name): the statement did nothing
            const attempt = () => {
              try {
                statement(db);
              } catch (error) {
                if (!/UNIQUE|constraint/i.test(String(error))) throw error;
              }
            };
            if (rng.chance(0.15)) {
              db.exec("SAVEPOINT s");
              attempt();
              attempt();
              if (rng.chance(0.5)) db.exec("ROLLBACK TO s");
              db.exec("RELEASE s");
            } else attempt();
          }
          if (doomed) throw new Error("rolled back");
        });
        requests += 1;
        kept?.push(pending);
        replay(replica, pending);
      } catch (error) {
        if (!(doomed && String(error).includes("rolled back"))) throw error;
        rolledBack += 1;
      }
      if (step % 25 === 0) same(source, replica);
    }
    same(source, replica);
    return { rolledBack, requests, source, replica };
  }

  test("1,500 requests over every kind of statement, rollbacks and savepoints, replayed one by one, end equal", () => {
    for (const seed of [1, 2, 3]) {
      const run = history(seed, 500);
      expect(run.rolledBack).toBeGreaterThan(10);
      expect(run.source.db.query("SELECT count(*) c FROM child").get()).toEqual(
        run.replica.db.query("SELECT count(*) c FROM child").get(),
      );
    }
  });

  test("the same history with its schema changing on the way, replayed many sets at a time (`applyAll`), ends as it does replayed one by one: the rows, the schema and the triggers", () => {
    const triggers = (world: World) =>
      world.db
        .query(
          "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE '\\_cdc%' ESCAPE '\\' ORDER BY name",
        )
        .all();
    for (const seed of [4, 5, 6]) {
      const kept: (Pending | null)[] = [];
      const run = history(seed, 400, kept);
      const sets = kept.filter((pending): pending is Pending => pending !== null);
      // Every step of the schema was in the history, and the sets that hold them are among the others.
      expect(
        sets.filter((pending) => pending.set.changes.some((change) => change.op === "ddl")).length,
      ).toBeGreaterThanOrEqual(6);
      for (const size of [1, 7, 64, sets.length]) {
        const together = open();
        for (let at = 0; at < sets.length; at += size) {
          const wire = sets
            .slice(at, at + size)
            .map((pending) => decodeChangeSet(encodeChangeSet(pending.set)));
          together.db.exec("PRAGMA foreign_keys=OFF");
          together.db.exec("BEGIN IMMEDIATE");
          together.capture.applyAll(wire);
          together.db.exec("COMMIT");
          together.db.exec("PRAGMA foreign_keys=ON");
        }
        same(run.source, together);
        same(run.replica, together);
        expect(triggers(together)).toEqual(triggers(run.replica));
        expect(triggers(together)).toEqual(triggers(run.source));
        expect(together.capture.hasUnsent()).toBe(false);
      }
    }
  });
});

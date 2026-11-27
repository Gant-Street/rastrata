/** What change capture costs a write, measured on SQL alone (no application): rows per second for
 * inserts, updates and deletes with no capture, with the triggers installed and switched off (the gate),
 * and with them recording; and what it costs to turn what they recorded into an entry (reading it back,
 * encoding, compressing, hashing).
 *
 *   bun experiments/e2-triggers.ts [--rows 60000] [--per 100] [--json out.json]
 *
 * An in-memory database is used so the numbers are the triggers' and not the disk's. */
import { Database } from "bun:sqlite";
import { ChangeCapture } from "../src/capture.ts";
import { encodeChangeSet } from "../src/codec.ts";
import { buildEntry } from "../src/entry.ts";
import { GENESIS_HASH } from "../src/tier.ts";
import { machine, parseArgs, printTable } from "./lib.ts";

interface Shape {
  readonly name: string;
  readonly ddl: string;
  readonly insert: string;
  readonly values: (index: number) => (string | number | null | Uint8Array)[];
  readonly update: string;
  readonly updateValues: (index: number) => (string | number | null)[];
}

const text = (index: number, length: number): string => `${index}-`.padEnd(length, "x");

const SHAPES: readonly Shape[] = [
  {
    name: "narrow (id, number, short text)",
    ddl: "CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b TEXT)",
    insert: "INSERT INTO t (id, a, b) VALUES (?, ?, ?)",
    values: (index) => [index, index * 3, `row ${index}`],
    update: "UPDATE t SET a = a + 1 WHERE id = ?",
    updateValues: (index) => [index],
  },
  {
    name: "wide (12 columns, two 300-byte texts, a blob)",
    ddl: "CREATE TABLE t (id TEXT PRIMARY KEY, a INTEGER, b INTEGER, c REAL, d TEXT, e TEXT, f BLOB, g TEXT, h INTEGER, i TEXT, j TEXT, k INTEGER)",
    insert: "INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    values: (index) => [
      `id-${index}`,
      index,
      index * 2,
      index / 7,
      text(index, 300),
      text(index, 300),
      new Uint8Array(64).fill(index % 251),
      `g${index}`,
      index % 9,
      null,
      `j${index}`,
      index,
    ],
    update: "UPDATE t SET a = a + 1, g = ? WHERE id = ?",
    updateValues: (index) => [`g-changed-${index}`, `id-${index}`],
  },
  {
    name: "without rowid, composite key",
    ddl: "CREATE TABLE t (a TEXT, b TEXT, c INTEGER, d TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID",
    insert: "INSERT INTO t (a, b, c, d) VALUES (?, ?, ?, ?)",
    values: (index) => [`a${index % 50}`, `b${index}`, index, `d ${index}`],
    update: "UPDATE t SET c = c + 1 WHERE a = ? AND b = ?",
    updateValues: (index) => [`a${index % 50}`, `b${index}`],
  },
];

type Mode = "none" | "dormant" | "recording";

function measure(shape: Shape, rows: number, per: number, mode: Mode) {
  const db = new Database(":memory:");
  db.exec("PRAGMA recursive_triggers=ON");
  db.exec(shape.ddl);
  const capture = new ChangeCapture(db, { exclude: [] });
  if (mode !== "none") {
    capture.install();
    capture.adopt();
    if (mode === "dormant") db.exec("UPDATE _cdc_gate SET on_=0");
  }
  const insert = db.query(shape.insert);
  const update = db.query(shape.update);
  const remove = db.query(
    shape.update.startsWith("UPDATE t SET a = a + 1 WHERE id")
      ? "DELETE FROM t WHERE id = ?"
      : shape.name.startsWith("wide")
        ? "DELETE FROM t WHERE id = ?"
        : "DELETE FROM t WHERE a = ? AND b = ?",
  );
  const deleteValues = (index: number) =>
    shape.name.startsWith("narrow")
      ? [index]
      : shape.name.startsWith("wide")
        ? [`id-${index}`]
        : [`a${index % 50}`, `b${index}`];

  const time = (
    work: (index: number) => void,
  ): { ms: number; read: number; encode: number; entry: number; bytes: number } => {
    let ms = 0;
    let read = 0;
    let encode = 0;
    let entry = 0;
    let bytes = 0;
    for (let first = 0; first < rows; first += per) {
      const started = performance.now();
      db.exec("BEGIN IMMEDIATE");
      for (let index = first; index < Math.min(rows, first + per); index += 1) work(index);
      const worked = performance.now();
      ms += worked - started;
      if (mode === "recording") {
        const pending = capture.peek();
        const peeked = performance.now();
        read += peeked - worked;
        if (pending) {
          const payload = encodeChangeSet(pending.set);
          const encoded = performance.now();
          encode += encoded - peeked;
          const built = buildEntry({
            bookId: "b",
            seq: 1,
            prev: GENESIS_HASH,
            writer: "w",
            fence: 1,
            schema: 1,
            kind: "commit",
            at: "2026-01-01T00:00:00.000Z",
            payload,
            changes: pending.count,
          });
          bytes += built.bytes.byteLength;
          entry += performance.now() - encoded;
          capture.settle(pending);
        }
      }
      db.exec("COMMIT");
    }
    return { ms, read, encode, entry, bytes };
  };
  const inserts = time((index) => insert.run(...shape.values(index)));
  const updates = time((index) => update.run(...shape.updateValues(index)));
  const deletes = time((index) => remove.run(...deleteValues(index)));
  db.close();
  return { inserts, updates, deletes };
}

function main(): void {
  const args = parseArgs();
  const rows = args.number("rows", 60000);
  const per = args.number("per", 100);
  const out: Record<string, unknown> = {};
  console.log(
    `Change capture on SQL alone: ${rows} rows per statement kind, ${per} rows per transaction. ${JSON.stringify(machine())}`,
  );
  const table: (string | number)[][] = [];
  for (const shape of SHAPES) {
    // Warm up once, then take the best of three of each mode (the least disturbed).
    measure(shape, Math.min(rows, 5000), per, "recording");
    const best = (mode: Mode) => {
      let chosen: ReturnType<typeof measure> | null = null;
      for (let round = 0; round < 3; round += 1) {
        const run = measure(shape, rows, per, mode);
        if (
          !chosen ||
          run.inserts.ms + run.updates.ms + run.deletes.ms <
            chosen.inserts.ms + chosen.updates.ms + chosen.deletes.ms
        )
          chosen = run;
      }
      return chosen as ReturnType<typeof measure>;
    };
    const none = best("none");
    const dormant = best("dormant");
    const recording = best("recording");
    const us = (ms: number) => ((ms * 1000) / rows).toFixed(2);
    for (const kind of ["inserts", "updates", "deletes"] as const) {
      table.push([
        shape.name,
        kind.slice(0, -1),
        us(none[kind].ms),
        us(dormant[kind].ms),
        us(recording[kind].ms),
        `+${(((recording[kind].ms - none[kind].ms) * 1000) / rows).toFixed(2)}`,
        `${(recording[kind].ms / none[kind].ms).toFixed(2)}x`,
        us(recording[kind].read),
        us(recording[kind].encode),
        us(recording[kind].entry),
        (recording[kind].bytes / rows).toFixed(1),
      ]);
    }
    out[shape.name] = { none, dormant, recording };
  }
  printTable(
    [
      "table",
      "statement",
      "no capture us/row",
      "triggers off us/row",
      "recording us/row",
      "overhead us/row",
      "x",
      "read back us/row",
      "encode us/row",
      "compress+hash us/row",
      "entry bytes/row",
    ],
    table,
  );
  const json = args.string("json", "");
  if (json) {
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(
      json,
      `${JSON.stringify({ rows, per, machine: machine(), results: out }, null, 2)}\n`,
    );
  }
}

main();

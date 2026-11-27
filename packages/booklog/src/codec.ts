/** The payload of an entry: the row changes a request made, in a compact binary form.
 *
 * A value is one of SQLite's five: NULL, INTEGER (a bigint, so no digit is ever lost), REAL (a
 * number), TEXT (a string) or BLOB (bytes). Nothing is converted to JSON on the way, so a replayed
 * row has the very same types and bytes as the original.
 *
 * Layout (all integers are LEB128; a signed integer is zigzag first):
 *   version byte (1)
 *   tables:  count, then per table: name, column count, column names, key column count, key indexes
 *   changes: count, then per change a one-byte op and its operands (see {@link Change}). */

export type SqlValue = null | bigint | number | string | Uint8Array;

export interface TableSpec {
  readonly name: string;
  /** Column names in the order a row carries them. A rowid table whose primary key is not the
   * rowid carries the rowid itself as the first column, named "rowid". */
  readonly columns: readonly string[];
  /** Indexes into `columns` of the columns that identify a row. */
  readonly key: readonly number[];
}

export type Change =
  /** A row was inserted. */
  | { readonly op: "insert"; readonly table: string; readonly row: readonly SqlValue[] }
  /** A row was changed; `key` is its key before the change, `row` the whole row after it. */
  | {
      readonly op: "update";
      readonly table: string;
      readonly key: readonly SqlValue[];
      readonly row: readonly SqlValue[];
    }
  | { readonly op: "delete"; readonly table: string; readonly key: readonly SqlValue[] }
  /** Schema: run this statement (a CREATE, ALTER or DROP). */
  | { readonly op: "ddl"; readonly sql: string }
  /** The table's whole content (a table that is new or was redefined): empty it, then insert these rows. */
  | {
      readonly op: "replace";
      readonly table: string;
      readonly rows: readonly (readonly SqlValue[])[];
    }
  /** The counter behind AUTOINCREMENT for a table (sqlite_sequence). */
  | { readonly op: "sequence"; readonly name: string; readonly value: bigint };

export interface ChangeSet {
  readonly tables: readonly TableSpec[];
  readonly changes: readonly Change[];
}

export const CODEC_VERSION = 1;

const OPS = { insert: 1, update: 2, delete: 3, ddl: 4, replace: 5, sequence: 6 } as const;
const TAG = { null: 0, integer: 1, real: 2, text: 3, blob: 4 } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

class Writer {
  bytes = new Uint8Array(1 << 14);
  length = 0;
  view = new DataView(this.bytes.buffer);

  ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < needed) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
  byte(value: number): void {
    this.ensure(1);
    this.bytes[this.length++] = value;
  }
  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new CodecError("Bad length");
    this.ensure(10);
    let rest = value;
    while (rest >= 0x80) {
      this.bytes[this.length++] = (rest % 0x80) | 0x80;
      rest = Math.floor(rest / 0x80);
    }
    this.bytes[this.length++] = rest;
  }
  bigVarint(value: bigint): void {
    this.ensure(11);
    let rest = value;
    while (rest >= 0x80n) {
      this.bytes[this.length++] = Number(rest & 0x7fn) | 0x80;
      rest >>= 7n;
    }
    this.bytes[this.length++] = Number(rest);
  }
  raw(data: Uint8Array): void {
    this.ensure(data.byteLength);
    this.bytes.set(data, this.length);
    this.length += data.byteLength;
  }
  string(text: string): void {
    const data = encoder.encode(text);
    this.varint(data.byteLength);
    this.raw(data);
  }
  value(value: SqlValue): void {
    if (value === null) {
      this.byte(TAG.null);
    } else if (typeof value === "bigint") {
      this.byte(TAG.integer);
      // zigzag over 64 bits
      const zigzag = BigInt.asUintN(64, (value << 1n) ^ (value >> 63n));
      if (zigzag < 0x80n) this.byte(Number(zigzag));
      else this.bigVarint(zigzag);
    } else if (typeof value === "number") {
      this.byte(TAG.real);
      this.ensure(8);
      this.view.setFloat64(this.length, value, true);
      this.length += 8;
    } else if (typeof value === "string") {
      this.byte(TAG.text);
      this.string(value);
    } else {
      this.byte(TAG.blob);
      this.varint(value.byteLength);
      this.raw(value);
    }
  }
  finish(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

class Reader {
  at = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get done(): boolean {
    return this.at >= this.bytes.length;
  }
  byte(): number {
    if (this.at >= this.bytes.length)
      throw new CodecError("The payload ends in the middle of a value");
    return this.bytes[this.at++] as number;
  }
  varint(): number {
    let result = 0;
    let scale = 1;
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = this.byte();
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) throw new CodecError("A length is too large");
        return result;
      }
      scale *= 0x80;
    }
    throw new CodecError("A length is too long");
  }
  bigVarint(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.byte();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
    throw new CodecError("An integer is too long");
  }
  take(length: number): Uint8Array {
    if (length < 0 || this.at + length > this.bytes.length)
      throw new CodecError("The payload ends in the middle of a value");
    const out = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }
  string(): string {
    try {
      return decoder.decode(this.take(this.varint()));
    } catch (error) {
      if (error instanceof CodecError) throw error;
      throw new CodecError("A string is not valid UTF-8");
    }
  }
  value(): SqlValue {
    const tag = this.byte();
    switch (tag) {
      case TAG.null:
        return null;
      case TAG.integer: {
        const zigzag = this.bigVarint();
        return BigInt.asIntN(64, (zigzag >> 1n) ^ -(zigzag & 1n));
      }
      case TAG.real: {
        const data = this.take(8);
        return new DataView(data.buffer, data.byteOffset, 8).getFloat64(0, true);
      }
      case TAG.text:
        return this.string();
      case TAG.blob:
        return this.take(this.varint()).slice();
      default:
        throw new CodecError(`Unknown value tag ${tag}`);
    }
  }
}

export function encodeChangeSet(set: ChangeSet): Uint8Array {
  const writer = new Writer();
  writer.byte(CODEC_VERSION);
  const index = new Map<string, number>();
  writer.varint(set.tables.length);
  set.tables.forEach((table, position) => {
    index.set(table.name, position);
    writer.string(table.name);
    writer.varint(table.columns.length);
    for (const column of table.columns) writer.string(column);
    writer.varint(table.key.length);
    for (const at of table.key) writer.varint(at);
  });
  const spec = (name: string): { position: number; table: TableSpec } => {
    const position = index.get(name);
    if (position === undefined) throw new CodecError(`No table spec for ${name}`);
    return { position, table: set.tables[position] as TableSpec };
  };
  writer.varint(set.changes.length);
  for (const change of set.changes) {
    writer.byte(OPS[change.op]);
    switch (change.op) {
      case "insert": {
        const { position, table } = spec(change.table);
        writer.varint(position);
        if (change.row.length !== table.columns.length)
          throw new CodecError(`Bad row width for ${table.name}`);
        for (const value of change.row) writer.value(value);
        break;
      }
      case "update": {
        const { position, table } = spec(change.table);
        writer.varint(position);
        if (change.key.length !== table.key.length || change.row.length !== table.columns.length)
          throw new CodecError(`Bad row width for ${table.name}`);
        for (const value of change.key) writer.value(value);
        for (const value of change.row) writer.value(value);
        break;
      }
      case "delete": {
        const { position, table } = spec(change.table);
        writer.varint(position);
        if (change.key.length !== table.key.length)
          throw new CodecError(`Bad key width for ${table.name}`);
        for (const value of change.key) writer.value(value);
        break;
      }
      case "ddl":
        writer.string(change.sql);
        break;
      case "replace": {
        const { position, table } = spec(change.table);
        writer.varint(position);
        writer.varint(change.rows.length);
        for (const row of change.rows) {
          if (row.length !== table.columns.length)
            throw new CodecError(`Bad row width for ${table.name}`);
          for (const value of row) writer.value(value);
        }
        break;
      }
      case "sequence":
        writer.string(change.name);
        writer.value(change.value);
        break;
    }
  }
  return writer.finish();
}

export function decodeChangeSet(bytes: Uint8Array): ChangeSet {
  const reader = new Reader(bytes);
  if (reader.byte() !== CODEC_VERSION) throw new CodecError("Unsupported payload version");
  const tableCount = reader.varint();
  if (tableCount > bytes.length) throw new CodecError("Impossible table count");
  const tables: TableSpec[] = [];
  for (let position = 0; position < tableCount; position += 1) {
    const name = reader.string();
    const columnCount = reader.varint();
    if (columnCount > bytes.length) throw new CodecError("Impossible column count");
    const columns: string[] = [];
    for (let column = 0; column < columnCount; column += 1) columns.push(reader.string());
    const keyCount = reader.varint();
    if (keyCount > columnCount) throw new CodecError("Impossible key width");
    const key: number[] = [];
    for (let at = 0; at < keyCount; at += 1) {
      const column = reader.varint();
      if (column >= columnCount) throw new CodecError("Key column out of range");
      key.push(column);
    }
    tables.push({ name, columns, key });
  }
  const changeCount = reader.varint();
  if (changeCount > bytes.length) throw new CodecError("Impossible change count");
  const changes: Change[] = [];
  const tableAt = (): TableSpec => {
    const position = reader.varint();
    const table = tables[position];
    if (!table) throw new CodecError("Table index out of range");
    return table;
  };
  const values = (count: number): SqlValue[] => {
    const out: SqlValue[] = [];
    for (let at = 0; at < count; at += 1) out.push(reader.value());
    return out;
  };
  for (let at = 0; at < changeCount; at += 1) {
    const op = reader.byte();
    switch (op) {
      case OPS.insert: {
        const table = tableAt();
        changes.push({ op: "insert", table: table.name, row: values(table.columns.length) });
        break;
      }
      case OPS.update: {
        const table = tableAt();
        const key = values(table.key.length);
        changes.push({ op: "update", table: table.name, key, row: values(table.columns.length) });
        break;
      }
      case OPS.delete: {
        const table = tableAt();
        changes.push({ op: "delete", table: table.name, key: values(table.key.length) });
        break;
      }
      case OPS.ddl:
        changes.push({ op: "ddl", sql: reader.string() });
        break;
      case OPS.replace: {
        const table = tableAt();
        const count = reader.varint();
        if (count > bytes.length) throw new CodecError("Impossible row count");
        const rows: SqlValue[][] = [];
        for (let row = 0; row < count; row += 1) rows.push(values(table.columns.length));
        changes.push({ op: "replace", table: table.name, rows });
        break;
      }
      case OPS.sequence: {
        const name = reader.string();
        const value = reader.value();
        if (typeof value !== "bigint") throw new CodecError("A sequence is not an integer");
        changes.push({ op: "sequence", name, value });
        break;
      }
      default:
        throw new CodecError(`Unknown change op ${op}`);
    }
  }
  if (!reader.done) throw new CodecError("The payload has trailing bytes");
  return { tables, changes };
}

/** The canonical bytes of one value, for hashing a row. */
export function encodeValue(value: SqlValue): Uint8Array {
  const writer = new Writer();
  writer.value(value);
  return writer.finish();
}

/** A reusable encoder for hashing rows without allocating per value. */
export class RowEncoder {
  readonly #writer = new Writer();
  row(values: readonly SqlValue[]): Uint8Array {
    this.#writer.length = 0;
    this.#writer.varint(values.length);
    for (const value of values) this.#writer.value(value);
    return this.#writer.bytes.subarray(0, this.#writer.length);
  }
}

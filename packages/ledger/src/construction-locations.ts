import { hashCanonical } from "@rastrata/kernel";
import type { IndexReaderPin } from "./index-control.ts";
import { requireLedger } from "./records.ts";
import type { SqlBinding, SqliteStorage } from "./sqlite.ts";
import { requireSqliteTransaction, type SqliteTransaction } from "./sqlite-transaction.ts";

const DOMAIN = "rastrata-construction-locations-v1";
const MAX = (1n << 128n) - 1n;
const HEX = /^[a-f0-9]{64}$/;
const NATURAL = /^(0|[1-9][0-9]{0,38})$/;
type Scope = { readonly pinId: string; readonly identityHash: string; readonly fence: string };
export interface ConstructionHead extends Scope {
  readonly count: string;
  readonly hash: string;
}
export interface ConstructionCursor {
  readonly through: string;
  readonly hash: string;
}
interface Entry extends Scope {
  readonly ordinal: string;
  readonly location: string;
  readonly previousHash: string;
}
const checksum = (kind: string, body: string) =>
  hashCanonical({ domain: `${DOMAIN}/${kind}`, body }).digest;
function shape(input: unknown, fields: string[]): Record<string, unknown> {
  requireLedger(
    input !== null &&
      typeof input === "object" &&
      Object.keys(input).length === fields.length &&
      fields.every((field) => Object.hasOwn(input, field)),
    "index_construction_tracking_corrupt",
  );
  return input as Record<string, unknown>;
}
function scope(input: Record<string, unknown>): Scope {
  requireLedger(
    typeof input.pinId === "string" &&
      /^[1-9][0-9]{0,63}$/.test(input.pinId) &&
      typeof input.identityHash === "string" &&
      HEX.test(input.identityHash) &&
      typeof input.fence === "string" &&
      /^(0|[1-9][0-9]{0,63})$/.test(input.fence),
    "index_construction_tracking_corrupt",
  );
  return Object.freeze({
    pinId: input.pinId,
    identityHash: input.identityHash,
    fence: input.fence,
  });
}
function count(input: unknown): string {
  requireLedger(
    typeof input === "string" && NATURAL.test(input) && BigInt(input) <= MAX,
    "index_construction_tracking_corrupt",
  );
  return input;
}
function hash(input: unknown): string {
  requireLedger(
    typeof input === "string" && HEX.test(input),
    "index_construction_tracking_corrupt",
  );
  return input;
}
function pinScope(pin: IndexReaderPin): Scope {
  requireLedger(pin.kind === "construction", "index_construction_pin_required");
  return scope({ pinId: pin.id, identityHash: pin.view.identityHash, fence: pin.view.fence });
}
function sameScope(a: Scope, b: Scope) {
  requireLedger(
    a.pinId === b.pinId && a.identityHash === b.identityHash && a.fence === b.fence,
    "index_construction_tracking_corrupt",
  );
}
function genesis(owner: Scope) {
  return checksum("genesis", JSON.stringify(owner));
}
function headCopy(input: unknown): ConstructionHead {
  const row = shape(input, ["pinId", "identityHash", "fence", "count", "hash"]);
  const head = Object.freeze({ ...scope(row), count: count(row.count), hash: hash(row.hash) });
  requireLedger(
    head.count !== "0" || head.hash === genesis(headScope(head)),
    "index_construction_tracking_corrupt",
  );
  return head;
}
function headScope(head: Scope): Scope {
  return { pinId: head.pinId, identityHash: head.identityHash, fence: head.fence };
}
function entryCopy(input: unknown): Entry {
  const row = shape(input, [
    "pinId",
    "identityHash",
    "fence",
    "ordinal",
    "location",
    "previousHash",
  ]);
  const owner = scope(row),
    ordinal = count(row.ordinal);
  requireLedger(
    ordinal !== "0" &&
      typeof row.location === "string" &&
      /^derived\/[a-f0-9]{64}$/.test(row.location) &&
      BigInt(owner.fence) <= MAX &&
      row.location.slice(8, 40) === BigInt(owner.fence).toString(16).padStart(32, "0") &&
      row.location.slice(40) !== "0".repeat(32),
    "index_construction_tracking_corrupt",
  );
  return Object.freeze({
    ...owner,
    ordinal,
    location: row.location,
    previousHash: hash(row.previousHash),
  });
}
const SELECT_BODY =
  "substr(body, 1, 4097) AS body, length(CAST(body AS BLOB)) AS body_bytes, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes";
const SELECT_PIN = "substr(pin_id, 1, 65) AS pin_id, length(CAST(pin_id AS BLOB)) AS pin_bytes";
const SELECT_ENTRY = `${SELECT_PIN}, substr(ordinal, 1, 40) AS ordinal, length(CAST(ordinal AS BLOB)) AS ordinal_bytes, ordinal_length, substr(location, 1, 73) AS location, length(CAST(location AS BLOB)) AS location_bytes, ${SELECT_BODY}`;
function decode(row: Record<string, unknown> | undefined, kind: string): unknown {
  requireLedger(
    row &&
      typeof row.body === "string" &&
      row.body.length <= 4096 &&
      new TextEncoder().encode(row.body).length === row.body_bytes &&
      row.digest_bytes === 64 &&
      row.digest === checksum(kind, row.body),
    "index_construction_tracking_corrupt",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.body);
  } catch {
    throw new Error("index_construction_tracking_corrupt");
  }
  requireLedger(JSON.stringify(parsed) === row.body, "index_construction_tracking_corrupt");
  return parsed;
}

/** Internal same-transaction metadata, not canonical accounting or a collector.
 * Every reserved location participates, including abandoned/unwritten ones.
 * Consumers must verify the entire captured chain before calling its set complete. */
export class ConstructionLocations {
  constructor(private readonly storage: SqliteStorage) {}
  private rows(sql: string, ...bindings: SqlBinding[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  initialize(transaction: SqliteTransaction) {
    requireSqliteTransaction(transaction, this.storage);
    this.rows(
      "CREATE TABLE ledger_index_construction_heads (pin_id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID",
    );
    this.rows(
      "CREATE TABLE ledger_index_construction_locations (pin_id TEXT NOT NULL, ordinal TEXT NOT NULL, ordinal_length INTEGER NOT NULL, location TEXT NOT NULL UNIQUE, body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(pin_id, ordinal)) WITHOUT ROWID",
    );
    this.rows(
      "CREATE INDEX ledger_index_construction_order ON ledger_index_construction_locations(pin_id, ordinal_length, ordinal)",
    );
    this.rows(
      "CREATE TABLE ledger_index_construction_cleanup (pin_id TEXT PRIMARY KEY, pin_length INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID",
    );
    this.rows(
      "CREATE INDEX ledger_index_construction_cleanup_order ON ledger_index_construction_cleanup(pin_length, pin_id)",
    );
  }
  create(transaction: SqliteTransaction, pin: IndexReaderPin) {
    requireSqliteTransaction(transaction, this.storage);
    const owner = pinScope(pin),
      head: ConstructionHead = { ...owner, count: "0", hash: genesis(owner) };
    const body = JSON.stringify(head);
    this.rows(
      "INSERT INTO ledger_index_construction_heads VALUES (?, ?, ?)",
      pin.id,
      body,
      checksum("head", body),
    );
  }
  head(pin: IndexReaderPin): ConstructionHead {
    return this.loadHead(pinScope(pin));
  }
  private loadHead(owner: Scope) {
    const row = this.rows(
      `SELECT ${SELECT_BODY} FROM ledger_index_construction_heads WHERE pin_id = ?`,
      owner.pinId,
    )[0];
    const head = headCopy(decode(row, "head"));
    sameScope(head, owner);
    requireLedger(JSON.stringify(head) === row?.body, "index_construction_tracking_corrupt");
    return head;
  }
  append(transaction: SqliteTransaction, pin: IndexReaderPin, locations: readonly string[]) {
    requireSqliteTransaction(transaction, this.storage);
    requireLedger(
      locations.length > 0 && locations.length <= 256,
      "index_construction_batch_invalid",
    );
    const before = this.head(pin);
    requireLedger(
      BigInt(before.count) + BigInt(locations.length) <= MAX,
      "index_construction_tracking_exhausted",
    );
    let ordinal = BigInt(before.count),
      previousHash = before.hash;
    for (const location of locations) {
      const entry = entryCopy({
        ...pinScope(pin),
        ordinal: String(++ordinal),
        location,
        previousHash,
      });
      const body = JSON.stringify(entry),
        digest = checksum("location", body);
      this.rows(
        "INSERT INTO ledger_index_construction_locations VALUES (?, ?, ?, ?, ?, ?)",
        pin.id,
        entry.ordinal,
        entry.ordinal.length,
        location,
        body,
        digest,
      );
      previousHash = digest;
    }
    const body = JSON.stringify({ ...pinScope(pin), count: String(ordinal), hash: previousHash });
    this.rows(
      "UPDATE ledger_index_construction_heads SET body = ?, digest = ? WHERE pin_id = ? AND body = ?",
      body,
      checksum("head", body),
      pin.id,
      JSON.stringify(before),
    );
    requireLedger(
      this.rows("SELECT changes() AS count")[0]?.count === 1,
      "index_construction_tracking_corrupt",
    );
  }
  owns(pin: IndexReaderPin, location: string) {
    const row = this.rows(
      `SELECT ${SELECT_ENTRY} FROM ledger_index_construction_locations WHERE location = ?`,
      location,
    )[0];
    requireLedger(row, "index_page_construction_mismatch");
    const { entry } = this.entry(row);
    requireLedger(
      entry.pinId === pin.id &&
        entry.identityHash === pin.view.identityHash &&
        entry.fence === pin.view.fence,
      "index_page_construction_mismatch",
    );
    requireLedger(
      BigInt(entry.ordinal) <= BigInt(this.head(pin).count),
      "index_construction_tracking_corrupt",
    );
  }
  private entry(row: Record<string, unknown>) {
    const entry = entryCopy(decode(row, "location"));
    requireLedger(
      entry.pinId === row.pin_id &&
        entry.pinId.length === row.pin_bytes &&
        entry.ordinal === row.ordinal &&
        entry.ordinal.length === row.ordinal_bytes &&
        entry.ordinal.length === row.ordinal_length &&
        entry.location === row.location &&
        entry.location.length === row.location_bytes &&
        JSON.stringify(entry) === row.body,
      "index_construction_tracking_corrupt",
    );
    return { entry, digest: hash(row.digest) };
  }
  start(head: ConstructionHead): ConstructionCursor {
    return Object.freeze({ through: "0", hash: genesis(headScope(head)) });
  }
  batch(head: ConstructionHead, cursor: ConstructionCursor, limit: number) {
    requireLedger(
      Number.isInteger(limit) && limit >= 1 && limit <= 256,
      "index_construction_batch_invalid",
    );
    const owner = headScope(head),
      live = this.loadHead(owner);
    requireLedger(
      BigInt(live.count) >= BigInt(head.count) &&
        (live.count !== head.count || live.hash === head.hash),
      "index_construction_tracking_corrupt",
    );
    const remaining = BigInt(head.count) - BigInt(cursor.through);
    requireLedger(remaining >= 0n, "index_construction_tracking_corrupt");
    const expected = Number(remaining < BigInt(limit) ? remaining : BigInt(limit));
    const rows = this.rows(
      `SELECT ${SELECT_ENTRY} FROM ledger_index_construction_locations WHERE pin_id = ? AND (ordinal_length, ordinal) > (?, ?) ORDER BY ordinal_length, ordinal LIMIT ?`,
      owner.pinId,
      cursor.through.length,
      cursor.through,
      expected + 1,
    );
    requireLedger(rows.length >= expected, "index_construction_tracking_gap");
    let through = BigInt(cursor.through),
      previous = cursor.hash;
    const locations: string[] = [];
    for (const row of rows.slice(0, expected)) {
      const { entry, digest } = this.entry(row);
      sameScope(entry, owner);
      requireLedger(
        BigInt(entry.ordinal) === ++through && entry.previousHash === previous,
        "index_construction_tracking_gap",
      );
      locations.push(entry.location);
      previous = digest;
    }
    const complete = String(through) === head.count;
    if (complete)
      requireLedger(
        previous === head.hash && (live.count !== head.count || rows.length === expected),
        "index_construction_tracking_gap",
      );
    return Object.freeze({
      locations: Object.freeze(locations),
      cursor: Object.freeze({ through: String(through), hash: previous }),
      complete,
    });
  }
  retire(transaction: SqliteTransaction, pin: IndexReaderPin) {
    requireSqliteTransaction(transaction, this.storage);
    const head = this.head(pin);
    const body = JSON.stringify({ head, ...this.start(head) });
    this.rows(
      "INSERT INTO ledger_index_construction_cleanup VALUES (?, ?, ?, ?)",
      pin.id,
      pin.id.length,
      body,
      checksum("cleanup", body),
    );
  }
  cleanup(
    transaction: SqliteTransaction,
    identityHash: string,
    limit: number,
    removeReservation: (location: string, owner: Scope) => void,
  ) {
    requireSqliteTransaction(transaction, this.storage);
    requireLedger(
      Number.isInteger(limit) && limit >= 1 && limit <= 256,
      "index_construction_batch_invalid",
    );
    const row = this.rows(
      `SELECT ${SELECT_PIN}, pin_length, ${SELECT_BODY} FROM ledger_index_construction_cleanup ORDER BY pin_length, pin_id LIMIT 1`,
    )[0];
    if (!row) return Object.freeze({ removed: 0, completed: false, pinId: null });
    const job = shape(decode(row, "cleanup"), ["head", "through", "hash"]);
    const head = headCopy(job.head),
      cursor = { through: count(job.through), hash: hash(job.hash) };
    requireLedger(
      head.identityHash === identityHash &&
        row.pin_id === head.pinId &&
        row.pin_bytes === head.pinId.length &&
        row.pin_length === head.pinId.length &&
        JSON.stringify({ head, ...cursor }) === row.body &&
        this.rows("SELECT id FROM ledger_index_pins WHERE id = ?", head.pinId).length === 0,
      "index_construction_cleanup_invalid",
    );
    // A retired construction cannot grow. Unlike a live captured-prefix reader,
    // cleanup must match its terminal head exactly and must not skip extant rows.
    const live = this.loadHead(headScope(head));
    requireLedger(
      live.count === head.count &&
        live.hash === head.hash &&
        this.rows(
          "SELECT 1 AS present FROM ledger_index_construction_locations WHERE pin_id = ? AND (ordinal_length, ordinal) <= (?, ?) LIMIT 1",
          head.pinId,
          cursor.through.length,
          cursor.through,
        ).length === 0,
      "index_construction_cleanup_invalid",
    );
    const batch = this.batch(head, cursor, limit);
    for (const location of batch.locations) {
      removeReservation(location, head);
      this.rows(
        "DELETE FROM ledger_index_construction_locations WHERE pin_id = ? AND location = ?",
        head.pinId,
        location,
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "index_construction_tracking_corrupt",
      );
    }
    if (batch.complete) {
      this.rows("DELETE FROM ledger_index_construction_heads WHERE pin_id = ?", head.pinId);
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "index_construction_tracking_corrupt",
      );
      this.rows("DELETE FROM ledger_index_construction_cleanup WHERE pin_id = ?", head.pinId);
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "index_construction_tracking_corrupt",
      );
    } else {
      const body = JSON.stringify({ head, ...batch.cursor });
      this.rows(
        "UPDATE ledger_index_construction_cleanup SET body = ?, digest = ? WHERE pin_id = ? AND body = ?",
        body,
        checksum("cleanup", body),
        head.pinId,
        row.body as string,
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "index_construction_tracking_corrupt",
      );
    }
    return Object.freeze({
      removed: batch.locations.length,
      completed: batch.complete,
      pinId: head.pinId,
    });
  }
}

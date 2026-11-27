import { hashCanonical } from "@rastrata/kernel";
import { LedgerError, requireLedger } from "./records.ts";
import type { SqlBinding, SqliteStorage } from "./sqlite.ts";
import {
  atomicSqlite,
  requireSqliteTransaction,
  type SqliteTransaction,
} from "./sqlite-transaction.ts";
import { verifyIndexRoot, type IndexRoot } from "./index-pages.ts";
import { ConstructionLocations } from "./construction-locations.ts";

const FORMAT = "rastrata-index-control-tracked-v1";
const MAX_BODY_BYTES = 16_384;
const digest = /^[0-9a-f]{64}$/;
const natural = /^(0|[1-9][0-9]{0,63})$/;

/** Owner-supplied synchronous reader of the SAME SQLite transaction's canonical
 * head and trusted identity/fence authority. Never populated from request JSON. */
export interface IndexAnchor {
  readonly identityHash: string;
  readonly headHash: string;
  readonly sequence: string;
  readonly fence: string;
  readonly provisioning: boolean;
  readonly pending: boolean;
}
export interface IndexView {
  readonly identityHash: string;
  readonly headHash: string;
  readonly sequence: string;
  readonly fence: string;
  readonly revision: string;
  readonly schema: string;
  readonly coldThrough: string;
  readonly coldRoot: string;
  readonly coldCount: string;
  readonly hotRoot: string;
  readonly hotCount: string;
}
export interface FrozenIndexPrefix {
  readonly id: string;
  readonly identityHash: string;
  readonly fence: string;
  readonly coldRoot: string;
  readonly coldThrough: string;
  readonly through: string;
  readonly prefixRoot: string;
  readonly prefixCount: string;
}
export interface IndexControl {
  readonly format: typeof FORMAT;
  readonly view: IndexView;
  readonly frozen: FrozenIndexPrefix | null;
}
export interface IndexReaderPin {
  readonly id: string;
  readonly kind: "reader" | "construction";
  readonly view: IndexView;
  readonly expiresAt: string;
}
export interface PreparedIndexPublication {
  readonly digest: string;
  readonly pinId: string;
  readonly view: IndexView;
  readonly next: IndexAnchor;
  readonly root: IndexRoot;
}
function preparedHash(body: string): string {
  return hashCanonical({ domain: "rastrata-prepared-index-publication-v1", body }).digest;
}
function preparedCopy(input: unknown) {
  const row = shape(input, ["pinId", "view", "next", "root"]);
  const pinId = text(row.pinId, "number");
  requireLedger(pinId !== "0", "index_prepared_publication_invalid");
  const view = viewCopy(row.view),
    next = anchorCopy(row.next);
  const descriptor = shape(row.root, ["contentHash", "keySchemaVersion", "population", "page"]);
  const root = verifyIndexRoot(row.root, text(descriptor.contentHash, "hash"));
  requireLedger(
    root.keySchemaVersion === view.schema &&
      next.identityHash === view.identityHash &&
      next.fence === view.fence &&
      !next.pending &&
      !next.provisioning &&
      BigInt(next.sequence) === BigInt(view.sequence) + 1n &&
      next.headHash !== view.headHash &&
      BigInt(root.population) >= BigInt(view.hotCount) + 1n,
    "index_prepared_publication_invalid",
  );
  return Object.freeze({ pinId, view, next, root });
}
type PinResult<T> = { value: T; issued?: string } | { error: string };

export function copyIndexReaderPin(input: unknown): IndexReaderPin {
  const row = shape(input, ["id", "kind", "view", "expiresAt"]);
  const id = text(row.id, "number");
  requireLedger(
    id !== "0" && (row.kind === "reader" || row.kind === "construction"),
    "index_pin_invalid",
  );
  return Object.freeze({
    id,
    kind: row.kind,
    view: viewCopy(row.view),
    expiresAt: text(row.expiresAt, "number"),
  });
}
function pinHash(body: string): string {
  return hashCanonical({ domain: "rastrata-index-pin-v1", body }).digest;
}

type ObjectRow = Record<string, unknown>;
function shape(value: unknown, fields: readonly string[]): ObjectRow {
  requireLedger(value !== null && typeof value === "object", "index_control_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireLedger(
    Reflect.ownKeys(value).length === fields.length &&
      fields.every((field) => descriptors[field] && "value" in descriptors[field]),
    "index_control_invalid",
  );
  return value as ObjectRow;
}
function text(value: unknown, kind: "hash" | "number" | "name") {
  requireLedger(typeof value === "string", "index_control_invalid");
  requireLedger(
    kind === "hash"
      ? digest.test(value)
      : kind === "number"
        ? natural.test(value)
        : /^[A-Za-z0-9._:/-]{1,256}$/.test(value),
    "index_control_invalid",
  );
  return value;
}
function viewCopy(input: unknown): IndexView {
  const names = [
    "identityHash",
    "headHash",
    "sequence",
    "fence",
    "revision",
    "schema",
    "coldThrough",
    "coldRoot",
    "coldCount",
    "hotRoot",
    "hotCount",
  ];
  const row = shape(input, names);
  const output: Record<string, string> = {};
  for (const name of names)
    output[name] = text(
      row[name],
      name.endsWith("Hash") || name.endsWith("Root")
        ? "hash"
        : name === "schema"
          ? "name"
          : "number",
    );
  const value = output as unknown as IndexView;
  requireLedger(BigInt(value.coldThrough) <= BigInt(value.sequence), "index_coverage_invalid");
  requireLedger(BigInt(value.coldCount) >= BigInt(value.coldThrough), "index_coverage_invalid");
  requireLedger(
    BigInt(value.hotCount) + BigInt(value.coldThrough) >= BigInt(value.sequence),
    "index_coverage_invalid",
  );
  requireLedger(
    value.coldThrough !== value.sequence || value.hotCount === "0",
    "index_coverage_invalid",
  );
  if (value.hotCount === "0")
    requireLedger(value.hotRoot === emptyIndexRoot(value.schema), "index_empty_root_mismatch");
  if (value.coldCount === "0")
    requireLedger(value.coldRoot === emptyIndexRoot(value.schema), "index_empty_root_mismatch");
  return Object.freeze(value);
}
function prefixCopy(input: unknown): FrozenIndexPrefix {
  const names = [
    "id",
    "identityHash",
    "fence",
    "coldRoot",
    "coldThrough",
    "through",
    "prefixRoot",
    "prefixCount",
  ];
  const row = shape(input, names);
  const output: Record<string, string> = {};
  for (const name of names)
    output[name] = text(
      row[name],
      name.endsWith("Hash") || name.endsWith("Root") ? "hash" : name === "id" ? "name" : "number",
    );
  return Object.freeze(output as unknown as FrozenIndexPrefix);
}
function controlCopy(input: unknown): IndexControl {
  const row = shape(input, ["format", "view", "frozen"]);
  requireLedger(row.format === FORMAT, "index_format_unsupported");
  const view = viewCopy(row.view);
  const frozen = row.frozen === null ? null : prefixCopy(row.frozen);
  if (frozen) {
    requireLedger(
      frozen.identityHash === view.identityHash &&
        frozen.fence === view.fence &&
        frozen.coldRoot === view.coldRoot &&
        frozen.coldThrough === view.coldThrough,
      "index_frozen_prefix_mismatch",
    );
    requireLedger(
      BigInt(frozen.through) > BigInt(view.coldThrough) &&
        BigInt(frozen.through) <= BigInt(view.sequence),
      "index_frozen_prefix_mismatch",
    );
    requireLedger(
      BigInt(frozen.prefixCount) >= BigInt(frozen.through) - BigInt(frozen.coldThrough) &&
        BigInt(frozen.prefixCount) <= BigInt(view.hotCount),
      "index_frozen_prefix_mismatch",
    );
  }
  return Object.freeze({ format: FORMAT, view, frozen });
}
function anchorCopy(input: unknown): IndexAnchor {
  const row = shape(input, [
    "identityHash",
    "headHash",
    "sequence",
    "fence",
    "provisioning",
    "pending",
  ]);
  requireLedger(
    typeof row.provisioning === "boolean" && typeof row.pending === "boolean",
    "index_control_invalid",
  );
  return Object.freeze({
    identityHash: text(row.identityHash, "hash"),
    headHash: text(row.headHash, "hash"),
    sequence: text(row.sequence, "number"),
    fence: text(row.fence, "number"),
    provisioning: row.provisioning,
    pending: row.pending,
  });
}
export { anchorCopy as copyIndexAnchor };
function equal(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function bodyHash(body: string) {
  return hashCanonical({ domain: FORMAT, body }).digest;
}

export function emptyIndexRoot(schema: string): string {
  text(schema, "name");
  return hashCanonical({
    domain: "rastrata-index-root-v1",
    keySchemaVersion: schema,
    population: "0",
    page: null,
  }).digest;
}

/** Storage-side index control only, intentionally not exported by the ledger API.
 * The owner MUST verify exact root descriptors, canonical populations and fetched
 * page integrity before providing roots or using returned metadata for evaluation.
 * This class supplies neither a root verifier nor service readiness. */
export class SqliteIndexControl {
  private readonly locations: ConstructionLocations;
  private uncertain = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: SqliteStorage,
    private readonly readAnchor: () => IndexAnchor,
    private readonly readNow?: () => bigint,
  ) {
    this.locations = new ConstructionLocations(storage);
  }
  private rows(sql: string, ...bindings: SqlBinding[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private requireCertain() {
    requireLedger(!this.uncertain, "index_write_uncertain");
  }
  private anchor() {
    return anchorCopy(this.readAnchor());
  }
  private aligned(view: IndexView, anchor: IndexAnchor) {
    requireLedger(
      view.identityHash === anchor.identityHash &&
        view.headHash === anchor.headHash &&
        view.sequence === anchor.sequence &&
        view.fence === anchor.fence,
      "index_anchor_mismatch",
    );
  }
  private load(): { value: IndexControl; body: string } {
    const rows = this.rows("SELECT body, digest FROM ledger_index_control LIMIT 2");
    requireLedger(rows.length === 1 && typeof rows[0]?.body === "string", "index_control_corrupt");
    const body = rows[0].body;
    requireLedger(
      new TextEncoder().encode(body).length <= MAX_BODY_BYTES && rows[0].digest === bodyHash(body),
      "index_control_corrupt",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new LedgerError("index_control_corrupt");
    }
    const value = controlCopy(parsed);
    requireLedger(JSON.stringify(value) === body, "index_control_corrupt");
    this.aligned(value.view, this.anchor());
    return { value, body };
  }
  private save(expected: string, value: IndexControl) {
    const body = JSON.stringify(controlCopy(value));
    requireLedger(new TextEncoder().encode(body).length <= MAX_BODY_BYTES, "index_control_invalid");
    this.rows(
      "UPDATE ledger_index_control SET body = ?, digest = ? WHERE singleton = 1 AND body = ?",
      body,
      bodyHash(body),
      expected,
    );
    requireLedger(this.rows("SELECT changes() AS count")[0]?.count === 1, "index_view_conflict");
  }
  private async mutate(fn: (transaction: SqliteTransaction) => void): Promise<IndexControl> {
    this.requireCertain();
    this.uncertain = true;
    const value = atomicSqlite(this.storage, (transaction) => {
      fn(transaction);
      return this.load().value;
    });
    await this.storage.sync();
    this.uncertain = false;
    return value;
  }
  initialize(schema: string): Promise<IndexControl> {
    text(schema, "name");
    return this.serial(() =>
      this.mutate((transaction) => this.initializeInTransaction(transaction, schema)),
    );
  }
  /** Same-store atomic first provisioning; caller confirms durability. */
  initializeInTransaction(transaction: SqliteTransaction, schema: string): void {
    requireSqliteTransaction(transaction, this.storage);
    text(schema, "name");
    const anchor = this.anchor();
    requireLedger(
      anchor.provisioning && !anchor.pending && anchor.sequence === "0",
      "index_initialization_forbidden",
    );
    this.rows(
      "CREATE TABLE ledger_index_control (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), body TEXT NOT NULL, digest TEXT NOT NULL)",
    );
    const root = emptyIndexRoot(schema);
    const value = controlCopy({
      format: FORMAT,
      view: {
        identityHash: anchor.identityHash,
        headHash: anchor.headHash,
        sequence: "0",
        fence: anchor.fence,
        revision: "0",
        schema,
        coldThrough: "0",
        coldRoot: root,
        coldCount: "0",
        hotRoot: root,
        hotCount: "0",
      },
      frozen: null,
    });
    const body = JSON.stringify(value);
    this.rows("INSERT INTO ledger_index_control VALUES (1, ?, ?)", body, bodyHash(body));
    this.rows(
      "CREATE TABLE ledger_index_pin_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), body TEXT NOT NULL, digest TEXT NOT NULL)",
    );
    this.rows(
      "CREATE TABLE ledger_index_pins (id TEXT PRIMARY KEY, expires_at TEXT NOT NULL, expiry_length INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID",
    );
    this.rows(
      "CREATE INDEX ledger_index_pin_expiry ON ledger_index_pins(expiry_length, expires_at, id)",
    );
    this.rows(
      "CREATE TABLE ledger_index_prepared_publications (pin_id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID",
    );
    this.locations.initialize(transaction);
    const pins = JSON.stringify({ issued: "0", lastTime: "0" });
    this.rows("INSERT INTO ledger_index_pin_state VALUES (1, ?, ?)", pins, pinHash(pins));
  }
  readMetadata(): Promise<IndexControl> {
    return this.serial(async () => {
      this.requireCertain();
      try {
        const value = this.storage.transactionSync(() => this.load().value);
        await this.storage.sync();
        return value;
      } catch (error) {
        this.uncertain = true;
        throw error;
      }
    });
  }
  recoverMetadata(): Promise<IndexControl> {
    return this.serial(async () => {
      this.uncertain = true;
      const value = this.storage.transactionSync(() => this.load().value);
      await this.storage.sync();
      this.uncertain = false;
      return value;
    });
  }
  private pinJson(row: ObjectRow | undefined): unknown {
    requireLedger(
      row &&
        typeof row.body === "string" &&
        row.body.length <= 8_192 &&
        new TextEncoder().encode(row.body).length === row.body_bytes &&
        row.digest_bytes === 64 &&
        row.digest === pinHash(row.body),
      "index_pin_storage_corrupt",
    );
    try {
      return JSON.parse(row.body);
    } catch {
      throw new LedgerError("index_pin_storage_corrupt");
    }
  }
  private loadPin(id: string): IndexReaderPin | undefined {
    const row = this.rows(
      "SELECT substr(body, 1, 8193) AS body, length(CAST(body AS BLOB)) AS body_bytes, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes, substr(expires_at, 1, 65) AS expires_at, length(CAST(expires_at AS BLOB)) AS expiry_bytes, expiry_length FROM ledger_index_pins WHERE id = ?",
      id,
    )[0];
    if (!row) return undefined;
    const pin = copyIndexReaderPin(this.pinJson(row));
    requireLedger(
      pin.id === id &&
        pin.expiresAt === row.expires_at &&
        pin.expiresAt.length === row.expiry_bytes &&
        pin.expiresAt.length === row.expiry_length &&
        JSON.stringify(pin) === row.body,
      "index_pin_storage_corrupt",
    );
    return pin;
  }
  private async pinOperation<T>(
    fn: (
      current: IndexView,
      now: bigint,
      issued: string,
      transaction: SqliteTransaction,
    ) => PinResult<T>,
  ): Promise<T> {
    return this.serial(async () => {
      this.requireCertain();
      requireLedger(this.readNow, "index_pin_clock_required");
      this.uncertain = true;
      const result = atomicSqlite(this.storage, (transaction) => {
        const current = this.load().value.view;
        const row = this.rows(
          "SELECT substr(body, 1, 8193) AS body, length(CAST(body AS BLOB)) AS body_bytes, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes FROM ledger_index_pin_state WHERE singleton = 1",
        )[0];
        const parsed = shape(this.pinJson(row), ["issued", "lastTime"]);
        const state = {
          issued: text(parsed.issued, "number"),
          lastTime: text(parsed.lastTime, "number"),
        };
        requireLedger(JSON.stringify(state) === row?.body, "index_pin_storage_corrupt");
        const now = this.readNow?.();
        requireLedger(typeof now === "bigint" && now >= 0n, "index_pin_clock_invalid");
        text(String(now), "number");
        if (now < BigInt(state.lastTime)) return { error: "index_pin_clock_regressed" };
        const outcome = fn(current, now, state.issued, transaction);
        // Even a normal expired/conflicting request durably advances the floor.
        // Rolling it back on an expiry error could let a clock rollback revive a pin.
        const body = JSON.stringify({
          issued: "value" in outcome ? (outcome.issued ?? state.issued) : state.issued,
          lastTime: String(now),
        });
        this.rows(
          "UPDATE ledger_index_pin_state SET body = ?, digest = ? WHERE singleton = 1 AND body = ?",
          body,
          pinHash(body),
          JSON.stringify(state),
        );
        requireLedger(
          this.rows("SELECT changes() AS count")[0]?.count === 1,
          "index_pin_storage_corrupt",
        );
        return outcome;
      });
      await this.storage.sync();
      this.uncertain = false;
      if ("error" in result) throw new LedgerError(result.error);
      return result.value;
    });
  }
  private pinAuthority(pin: IndexReaderPin, current: IndexView) {
    return pin.view.identityHash === current.identityHash && pin.view.fence === current.fence;
  }
  private removePin(pin: IndexReaderPin, transaction: SqliteTransaction) {
    if (pin.kind === "construction") this.locations.retire(transaction, pin);
    this.rows(
      "DELETE FROM ledger_index_pins WHERE id = ? AND body = ?",
      pin.id,
      JSON.stringify(pin),
    );
    requireLedger(
      this.rows("SELECT changes() AS count")[0]?.count === 1,
      "index_pin_storage_corrupt",
    );
    this.rows("DELETE FROM ledger_index_prepared_publications WHERE pin_id = ?", pin.id);
  }
  private constructionPin(
    current: IndexView,
    now: bigint,
    captured: IndexReaderPin,
    transaction: SqliteTransaction,
  ): PinResult<IndexReaderPin> {
    if (!this.pinAuthority(captured, current) || this.anchor().pending)
      return { error: "index_pin_view_conflict" };
    const stored = this.loadPin(captured.id);
    if (!stored) return { error: "index_pin_not_active" };
    if (BigInt(stored.expiresAt) <= now) {
      this.removePin(stored, transaction);
      return { error: "index_pin_expired" };
    }
    if (!equal(stored, captured)) return { error: "index_pin_conflict" };
    this.locations.head(stored);
    return { value: stored };
  }
  private loadPrepared(pin: IndexReaderPin): PreparedIndexPublication | undefined {
    const row = this.rows(
      "SELECT substr(body, 1, 8193) AS body, length(CAST(body AS BLOB)) AS body_bytes, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes FROM ledger_index_prepared_publications WHERE pin_id = ?",
      pin.id,
    )[0];
    if (!row) return undefined;
    requireLedger(
      typeof row.body === "string" &&
        row.body.length <= 8192 &&
        new TextEncoder().encode(row.body).length === row.body_bytes &&
        row.digest_bytes === 64 &&
        row.digest === preparedHash(row.body),
      "index_prepared_publication_corrupt",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.body);
    } catch {
      throw new LedgerError("index_prepared_publication_corrupt");
    }
    const value = preparedCopy(parsed);
    requireLedger(
      value.pinId === pin.id && equal(value.view, pin.view) && JSON.stringify(value) === row.body,
      "index_prepared_publication_corrupt",
    );
    return Object.freeze({ digest: row.digest as string, ...value });
  }
  /** Owner-only registration after full durable graph verification. Verification
   * must read the descriptor in this exact transaction; no caller boolean is used.
   * Canonical population/lineage checks remain a separate owner prerequisite. */
  registerPrepared(
    storage: SqliteStorage,
    expected: IndexReaderPin,
    root: IndexRoot,
    next: IndexAnchor,
    readVerifiedRoot: () => IndexRoot | undefined,
  ): Promise<PreparedIndexPublication> {
    requireLedger(storage === this.storage, "index_construction_storage_mismatch");
    const captured = copyIndexReaderPin(expected);
    requireLedger(captured.kind === "construction", "index_construction_pin_required");
    const candidate = preparedCopy({ pinId: captured.id, view: captured.view, next, root });
    const body = JSON.stringify(candidate);
    requireLedger(
      new TextEncoder().encode(body).length <= 8192,
      "index_prepared_publication_invalid",
    );
    return this.pinOperation((current, now, _issued, transaction) => {
      const admitted = this.constructionPin(current, now, captured, transaction);
      if ("error" in admitted) return admitted;
      if (!equal(current, captured.view)) return { error: "index_view_conflict" };
      requireLedger(equal(readVerifiedRoot(), candidate.root), "index_prepared_root_unverified");
      const existing = this.loadPrepared(admitted.value);
      const digest = preparedHash(body);
      if (existing)
        return existing.digest === digest
          ? { value: existing }
          : { error: "index_prepared_publication_conflict" };
      this.rows(
        "INSERT INTO ledger_index_prepared_publications VALUES (?, ?, ?)",
        captured.id,
        body,
        digest,
      );
      return { value: Object.freeze({ digest, ...candidate }) };
    });
  }
  readPrepared(expected: IndexReaderPin): Promise<PreparedIndexPublication | undefined> {
    const captured = copyIndexReaderPin(expected);
    requireLedger(captured.kind === "construction", "index_construction_pin_required");
    return this.pinOperation((current, now, _issued, transaction) => {
      const admitted = this.constructionPin(current, now, captured, transaction);
      if ("error" in admitted) return admitted;
      return { value: this.loadPrepared(admitted.value) };
    });
  }
  /** Atomically select precisely the registered root/target head and consume its
   * live construction pin. A lost reply is reconciled from canonical/index heads;
   * repeating this low-level call must not create a second publication. */
  publishPrepared(
    expected: IndexReaderPin,
    digest: string,
    writeCanonical: (transaction: SqliteTransaction) => undefined,
  ): Promise<IndexControl> {
    const captured = copyIndexReaderPin(expected);
    requireLedger(captured.kind === "construction", "index_construction_pin_required");
    text(digest, "hash");
    return this.pinOperation((current, now, _issued, transaction) => {
      const admitted = this.constructionPin(current, now, captured, transaction);
      if ("error" in admitted) return admitted;
      if (!equal(current, captured.view)) return { error: "index_view_conflict" };
      const prepared = this.loadPrepared(admitted.value);
      if (!prepared) return { error: "index_prepared_publication_missing" };
      if (prepared.digest !== digest) return { error: "index_prepared_publication_conflict" };
      this.applyAppend(
        transaction,
        current,
        prepared.next,
        prepared.root.contentHash,
        prepared.root.population,
        writeCanonical,
      );
      this.removePin(admitted.value, transaction);
      return { value: this.load().value };
    });
  }
  /** Trusted owner API: the current view must already have canonical population
   * and page verification. Admission and complete-view CAS share one transaction.
   * IDs are allocated here, never supplied by a client or reused after release. */
  pinCurrent(
    expected: IndexView,
    kind: IndexReaderPin["kind"],
    expiresAt: string,
  ): Promise<IndexReaderPin> {
    const captured = viewCopy(expected);
    text(expiresAt, "number");
    requireLedger(kind === "reader" || kind === "construction", "index_pin_invalid");
    return this.pinOperation((current, now, issued, transaction) => {
      if (!equal(current, captured) || this.anchor().pending)
        return { error: "index_pin_view_conflict" };
      if (BigInt(expiresAt) <= now) return { error: "index_pin_expired" };
      const pin = copyIndexReaderPin({
        id: text(String(BigInt(issued) + 1n), "number"),
        kind,
        view: captured,
        expiresAt,
      });
      const body = JSON.stringify(pin);
      this.rows(
        "INSERT INTO ledger_index_pins VALUES (?, ?, ?, ?, ?)",
        pin.id,
        pin.expiresAt,
        pin.expiresAt.length,
        body,
        pinHash(body),
      );
      if (pin.kind === "construction") this.locations.create(transaction, pin);
      return { value: pin, issued: pin.id };
    });
  }
  readPinned(expected: IndexReaderPin): Promise<IndexReaderPin> {
    const captured = copyIndexReaderPin(expected);
    return this.pinOperation((current, now, _issued, transaction) => {
      if (!this.pinAuthority(captured, current) || this.anchor().pending)
        return { error: "index_pin_view_conflict" };
      const stored = this.loadPin(captured.id);
      if (!stored) return { error: "index_pin_not_active" };
      if (BigInt(stored.expiresAt) <= now) {
        this.removePin(stored, transaction);
        return { error: "index_pin_expired" };
      }
      if (!equal(stored, captured)) return { error: "index_pin_conflict" };
      return { value: stored };
    });
  }
  /** Internal owner port for construction writes in this exact SQLite transaction.
   * This is not a caller-supplied callback or accounting publication API. The
   * callback may neither yield nor nest transactions. Expiry and the clock floor
   * are handled by the same durable pin operation as the guarded write. */
  runPinnedConstruction(
    storage: SqliteStorage,
    expected: IndexReaderPin,
    write: (pin: IndexReaderPin, transaction: SqliteTransaction) => undefined,
  ): Promise<void> {
    requireLedger(storage === this.storage, "index_construction_storage_mismatch");
    const captured = copyIndexReaderPin(expected);
    requireLedger(captured.kind === "construction", "index_construction_pin_required");
    return this.pinOperation((current, now, _issued, transaction) => {
      const admitted = this.constructionPin(current, now, captured, transaction);
      if ("error" in admitted) return admitted;
      requireLedger(
        write(admitted.value, transaction) === undefined,
        "index_async_write_forbidden",
      );
      return { value: undefined };
    });
  }
  renewPin(expected: IndexReaderPin, expiresAt: string): Promise<IndexReaderPin> {
    const captured = copyIndexReaderPin(expected);
    text(expiresAt, "number");
    const renewed = copyIndexReaderPin({ ...captured, expiresAt });
    return this.pinOperation((current, now, _issued, transaction) => {
      if (!this.pinAuthority(captured, current) || this.anchor().pending)
        return { error: "index_pin_view_conflict" };
      const stored = this.loadPin(captured.id);
      if (!stored) return { error: "index_pin_not_active" };
      if (BigInt(stored.expiresAt) <= now) {
        this.removePin(stored, transaction);
        return { error: "index_pin_expired" };
      }
      if (equal(stored, renewed)) return { value: stored }; // Exact retry after lost renewal response.
      if (!equal(stored, captured) || BigInt(expiresAt) <= BigInt(stored.expiresAt))
        return { error: "index_pin_conflict" };
      const body = JSON.stringify(renewed);
      this.rows(
        "UPDATE ledger_index_pins SET expires_at = ?, expiry_length = ?, body = ?, digest = ? WHERE id = ? AND body = ?",
        expiresAt,
        expiresAt.length,
        body,
        pinHash(body),
        stored.id,
        JSON.stringify(stored),
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "index_pin_storage_corrupt",
      );
      return { value: renewed };
    });
  }
  releasePin(expected: IndexReaderPin): Promise<void> {
    const captured = copyIndexReaderPin(expected);
    return this.pinOperation((current, _now, issued, transaction) => {
      if (!this.pinAuthority(captured, current)) return { error: "index_pin_view_conflict" };
      if (BigInt(captured.id) > BigInt(issued)) return { error: "index_pin_not_active" };
      const stored = this.loadPin(captured.id);
      if (!stored) return { value: undefined };
      if (!equal(stored, captured)) return { error: "index_pin_conflict" };
      this.removePin(stored, transaction);
      return { value: undefined };
    });
  }
  /** Bounded maintenance of expired pin rows only. This never retires or deletes
   * pages. The issued-ID high water mark remains after all rows are gone. */
  reapExpiredPins(limit: number): Promise<number> {
    requireLedger(
      Number.isInteger(limit) && limit >= 1 && limit <= 1_000,
      "index_pin_batch_invalid",
    );
    return this.pinOperation((_current, now, _issued, transaction) => {
      const cutoff = String(now);
      const ids = this.rows(
        "SELECT id FROM ledger_index_pins WHERE (expiry_length, expires_at) <= (?, ?) ORDER BY expiry_length, expires_at, id LIMIT ?",
        cutoff.length,
        cutoff,
        limit,
      );
      for (const row of ids) {
        const pin = this.loadPin(text(row.id, "number"));
        requireLedger(pin && BigInt(pin.expiresAt) <= now, "index_pin_storage_corrupt");
        this.removePin(pin, transaction);
      }
      return { value: ids.length };
    });
  }
  /** Internal bounded metadata-maintenance port, not authority to delete pages.
   * It shares trusted time/fence admission and one transaction with its callback. */
  runIndexMaintenance(
    storage: SqliteStorage,
    write: (view: IndexView, transaction: SqliteTransaction) => undefined,
  ): Promise<void> {
    requireLedger(storage === this.storage, "index_construction_storage_mismatch");
    return this.pinOperation((current, _now, _issued, transaction) => {
      if (this.anchor().pending) return { error: "index_pin_view_conflict" };
      requireLedger(write(current, transaction) === undefined, "index_async_write_forbidden");
      return { value: undefined };
    });
  }
  freeze(expected: IndexView, id: string): Promise<IndexControl> {
    const captured = viewCopy(expected);
    text(id, "name");
    return this.serial(() =>
      this.mutate(() => {
        const stored = this.load();
        requireLedger(
          equal(stored.value.view, captured) &&
            stored.value.frozen === null &&
            !this.anchor().pending,
          "index_view_conflict",
        );
        requireLedger(
          BigInt(captured.sequence) > BigInt(captured.coldThrough),
          "index_empty_freeze",
        );
        const frozen: FrozenIndexPrefix = {
          id,
          identityHash: captured.identityHash,
          fence: captured.fence,
          coldRoot: captured.coldRoot,
          coldThrough: captured.coldThrough,
          through: captured.sequence,
          prefixRoot: captured.hotRoot,
          prefixCount: captured.hotCount,
        };
        this.save(stored.body, { ...stored.value, frozen });
      }),
    );
  }
  /** The callback writes canonical SQL inside this transaction, without nesting
   * transactionSync or yielding. It is an owner implementation port, not user code. */
  append(
    expected: IndexView,
    resultingAnchor: IndexAnchor,
    hotRoot: string,
    hotCount: string,
    writeCanonical: (transaction: SqliteTransaction) => undefined,
  ): Promise<IndexControl> {
    const captured = viewCopy(expected);
    const next = anchorCopy(resultingAnchor);
    text(hotRoot, "hash");
    text(hotCount, "number");
    return this.serial(() =>
      this.mutate((transaction) =>
        this.applyAppend(transaction, captured, next, hotRoot, hotCount, writeCanonical),
      ),
    );
  }
  private applyAppend(
    transaction: SqliteTransaction,
    captured: IndexView,
    next: IndexAnchor,
    hotRoot: string,
    hotCount: string,
    writeCanonical: (transaction: SqliteTransaction) => undefined,
  ) {
    const stored = this.load();
    requireLedger(equal(stored.value.view, captured), "index_view_conflict");
    requireLedger(
      next.identityHash === captured.identityHash &&
        next.fence === captured.fence &&
        BigInt(next.sequence) === BigInt(captured.sequence) + 1n &&
        next.headHash !== captured.headHash &&
        BigInt(hotCount) >= BigInt(captured.hotCount) + 1n,
      "index_append_invalid",
    );
    requireLedger(writeCanonical(transaction) === undefined, "index_async_write_forbidden");
    requireLedger(equal(this.anchor(), next), "index_anchor_mismatch");
    this.save(stored.body, {
      ...stored.value,
      view: {
        ...captured,
        headHash: next.headHash,
        sequence: next.sequence,
        revision: (BigInt(captured.revision) + 1n).toString(),
        hotRoot,
        hotCount,
      },
    });
  }
  /** Roots must already have durable, verified exact prefix/tail membership. Count
   * checks here are only additional storage-side guards, not that verification. */
  install(
    expected: IndexView,
    prefix: FrozenIndexPrefix,
    coldRoot: string,
    tailRoot: string,
    tailCount: string,
  ): Promise<IndexControl> {
    const captured = viewCopy(expected);
    const selected = prefixCopy(prefix);
    text(coldRoot, "hash");
    text(tailRoot, "hash");
    text(tailCount, "number");
    return this.serial(() =>
      this.mutate(() => {
        const stored = this.load();
        requireLedger(
          equal(stored.value.view, captured) &&
            equal(stored.value.frozen, selected) &&
            !this.anchor().pending,
          "index_view_conflict",
        );
        requireLedger(
          BigInt(tailCount) + BigInt(selected.prefixCount) === BigInt(captured.hotCount),
          "index_tail_mismatch",
        );
        if (captured.sequence === selected.through)
          requireLedger(tailRoot === emptyIndexRoot(captured.schema), "index_empty_root_mismatch");
        this.save(stored.body, {
          format: FORMAT,
          frozen: null,
          view: {
            ...captured,
            revision: (BigInt(captured.revision) + 1n).toString(),
            coldThrough: selected.through,
            coldRoot,
            coldCount: (BigInt(captured.coldCount) + BigInt(selected.prefixCount)).toString(),
            hotRoot: tailRoot,
            hotCount: tailCount,
          },
        });
      }),
    );
  }
}

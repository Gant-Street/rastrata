/** Product state of the ingestion pipeline: what the sources handed over, what became of each line,
 * and the raw payloads behind them. Reached only through `service.store`.
 *
 * Tables (all created by `migrate`, append-only):
 * - `app_blobs`, `app_blob_chunks`: the content-addressed raw store, keyed by SHA-256, in chunks
 *   small enough for a hosted row limit.
 * - `app_ingest_sources`: one row per provider account, mapping it to a chart account and holding
 *   its cutover date.
 * - `app_ingest_batches`: one row per submitted payload (raw hash, counts, cursor, balances).
 * - `app_ingest_items`: one row per line, never deleted. Provider identifiers and overlap
 *   occurrences are hard unique indexes, so a duplicate is refused by the database itself even if
 *   the application logic had a bug.
 * - `app_ingest_proposals`: the current suggestions for each open item.
 * - `app_ingest_conflicts`: lines a provider later reported differently from what was imported.
 * - `app_ingest_settings`: matcher configuration overrides. */
import { sha256Hex } from "../../ingest/hash.ts";
import type { IngestItem, IngestLine } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationBinding, ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";

export const MIGRATIONS: readonly string[] = [
  // 1: the raw store.
  `CREATE TABLE app_blobs (
     sha256 TEXT PRIMARY KEY,
     size INTEGER NOT NULL,
     media_type TEXT NOT NULL,
     name TEXT,
     chunks INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE app_blob_chunks (
     sha256 TEXT NOT NULL,
     seq INTEGER NOT NULL,
     body BLOB NOT NULL,
     PRIMARY KEY (sha256, seq)
   ) WITHOUT ROWID;`,
  // 2: sources, batches, items, proposals, conflicts, settings.
  `CREATE TABLE app_ingest_sources (
     provider TEXT NOT NULL,
     account_key TEXT NOT NULL,
     ledger_account_id TEXT,
     start_on TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (provider, account_key)
   );
   CREATE TABLE app_ingest_batches (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     provider TEXT NOT NULL,
     source_key TEXT NOT NULL,
     content_hash TEXT NOT NULL UNIQUE,
     raw_sha256 TEXT NOT NULL,
     raw_size INTEGER NOT NULL,
     raw_media_type TEXT NOT NULL,
     raw_name TEXT,
     fetched_at TEXT NOT NULL,
     submitted_at TEXT NOT NULL,
     cursor TEXT,
     catch_up INTEGER NOT NULL DEFAULT 0,
     line_count INTEGER NOT NULL,
     new_count INTEGER NOT NULL,
     duplicate_count INTEGER NOT NULL,
     overlap_count INTEGER NOT NULL,
     invalid_count INTEGER NOT NULL,
     excluded_count INTEGER NOT NULL,
     balances TEXT NOT NULL
   );
   CREATE INDEX app_ingest_batches_source ON app_ingest_batches (provider, source_key, seq);
   CREATE TABLE app_ingest_batch_sources (
     batch_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     account_key TEXT NOT NULL,
     PRIMARY KEY (batch_id, provider, account_key)
   ) WITHOUT ROWID;
   CREATE TABLE app_ingest_items (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     batch_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     account_key TEXT NOT NULL,
     provider_id TEXT,
     fingerprint TEXT,
     occurrence INTEGER,
     raw_index INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('bankLine', 'event')),
     posted_on TEXT NOT NULL,
     cents INTEGER NOT NULL,
     amount TEXT NOT NULL,
     currency TEXT NOT NULL,
     content_key TEXT NOT NULL,
     text_key TEXT NOT NULL,
     search TEXT NOT NULL,
     line TEXT NOT NULL,
     excerpt TEXT,
     flags TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL CHECK (status IN ('new', 'proposed', 'drafted', 'posted', 'excluded')),
     exclusion_code TEXT CHECK (exclusion_code IN ('manual', 'before_cutover', 'catch_up')),
     exclusion_reason TEXT,
     exclusion_at TEXT,
     source_event_id TEXT NOT NULL UNIQUE,
     ingested_at TEXT NOT NULL,
     proposed_rev TEXT,
     proposed_head TEXT,
     proposal_problems TEXT NOT NULL DEFAULT '[]',
     decision TEXT,
     draft_id TEXT,
     draft_version INTEGER,
     journal_id TEXT,
     matched_journal_id TEXT,
     pair_item_id TEXT,
     post_operation_id TEXT,
     post_error TEXT,
     CHECK ((provider_id IS NOT NULL) OR (fingerprint IS NOT NULL AND occurrence IS NOT NULL))
   );
   CREATE UNIQUE INDEX app_ingest_items_provider_id
     ON app_ingest_items (provider, account_key, provider_id) WHERE provider_id IS NOT NULL;
   CREATE UNIQUE INDEX app_ingest_items_occurrence
     ON app_ingest_items (provider, account_key, fingerprint, occurrence) WHERE provider_id IS NULL;
   CREATE UNIQUE INDEX app_ingest_items_match
     ON app_ingest_items (matched_journal_id) WHERE matched_journal_id IS NOT NULL;
   CREATE INDEX app_ingest_items_status ON app_ingest_items (status, posted_on);
   CREATE INDEX app_ingest_items_date ON app_ingest_items (posted_on);
   CREATE INDEX app_ingest_items_amount ON app_ingest_items (cents, posted_on);
   CREATE INDEX app_ingest_items_source ON app_ingest_items (provider, account_key, posted_on);
   CREATE INDEX app_ingest_items_batch ON app_ingest_items (batch_id);
   CREATE INDEX app_ingest_items_draft ON app_ingest_items (draft_id) WHERE draft_id IS NOT NULL;
   CREATE TABLE app_ingest_proposals (
     item_id TEXT NOT NULL,
     rank INTEGER NOT NULL,
     id TEXT NOT NULL,
     proposer TEXT NOT NULL,
     kind TEXT NOT NULL,
     confidence INTEGER NOT NULL,
     body TEXT NOT NULL,
     PRIMARY KEY (item_id, rank)
   ) WITHOUT ROWID;
   CREATE INDEX app_ingest_proposals_proposer ON app_ingest_proposals (proposer, kind, confidence);
   CREATE TABLE app_ingest_conflicts (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     item_id TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     line TEXT NOT NULL,
     reason TEXT NOT NULL,
     seen_at TEXT NOT NULL
   );
   CREATE INDEX app_ingest_conflicts_item ON app_ingest_conflicts (item_id);
   CREATE TABLE app_ingest_settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) WITHOUT ROWID;`,
  // 3: what was done to each line, for the record.
  `CREATE TABLE app_ingest_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     item_id TEXT NOT NULL,
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     actor TEXT NOT NULL,
     detail TEXT NOT NULL
   );
   CREATE INDEX app_ingest_events_item ON app_ingest_events (item_id, seq);`,
  // 4: lines booked by another line (balance transactions covered by their payout).
  `ALTER TABLE app_ingest_items ADD COLUMN covered_by TEXT;
   CREATE INDEX app_ingest_items_cover
     ON app_ingest_items (provider, account_key, covered_by) WHERE covered_by IS NOT NULL;`,
  // 5: how many times the line has been undone. The ledger refuses a second journal for a source
  // identity and a reversal does not free it, so each posting of a line after an undo is made under
  // the next generation of its identity (see `ledgerSourceId`). It only ever grows.
  `ALTER TABLE app_ingest_items ADD COLUMN source_generation INTEGER NOT NULL DEFAULT 0;`,
  // 6: why a line's last posting failed, when trying again will not change it (the ledger refused the
  // entry, the draft is gone, the date is outside the calendar). Empty for a failure that may pass by
  // itself (the book changed under the posting) and for every line written before this column: those
  // are tried once more, and a failure that stands is then recorded here. A post by filter leaves a
  // line with a code alone until the books change (the calendar, a month, the chart: see
  // `forgetFailuresThatMayHavePassed`, which clears the codes then); a post by ids tries it again.
  `ALTER TABLE app_ingest_items ADD COLUMN post_error_code TEXT;`,
  // 7: what changed in the Inbox that its suggestions depend on, kept by the database itself so that no path
  // that changes a line can forget to say so. A row is written when a line is decided or posted or taken back
  // (item_id, no journal_id), and one for each entry a line becomes linked to or stops being linked to
  // (item_id and journal_id). A line moving between "new" and "proposed" is the Inbox's own bookkeeping and is
  // not a change. The suggestions are kept current from this log and the ledger's new revisions (see
  // `proposing.ts`), not worked out again from every entry of the book at each read. The index on journal_id
  // answers "is this entry linked to a line" without reading every line.
  `CREATE INDEX app_ingest_items_journal ON app_ingest_items (journal_id) WHERE journal_id IS NOT NULL;
   CREATE TABLE app_ingest_changes (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     item_id TEXT NOT NULL,
     journal_id TEXT
   );
   CREATE TRIGGER app_ingest_changes_inserted AFTER INSERT ON app_ingest_items
   WHEN NEW.status IN ('drafted', 'posted') OR NEW.decision IS NOT NULL
     OR NEW.journal_id IS NOT NULL OR NEW.matched_journal_id IS NOT NULL
   BEGIN
     INSERT INTO app_ingest_changes (item_id, journal_id) VALUES (NEW.id, NULL);
     INSERT INTO app_ingest_changes (item_id, journal_id)
       SELECT NEW.id, NEW.journal_id WHERE NEW.journal_id IS NOT NULL;
     INSERT INTO app_ingest_changes (item_id, journal_id)
       SELECT NEW.id, NEW.matched_journal_id WHERE NEW.matched_journal_id IS NOT NULL;
   END;
   CREATE TRIGGER app_ingest_changes_updated AFTER UPDATE ON app_ingest_items
   WHEN OLD.status IS NOT NEW.status OR OLD.decision IS NOT NEW.decision
     OR OLD.journal_id IS NOT NEW.journal_id OR OLD.matched_journal_id IS NOT NEW.matched_journal_id
   BEGIN
     INSERT INTO app_ingest_changes (item_id, journal_id)
       SELECT NEW.id, NULL
       WHERE OLD.decision IS NOT NEW.decision
         OR OLD.journal_id IS NOT NEW.journal_id OR OLD.matched_journal_id IS NOT NEW.matched_journal_id
         OR NOT (OLD.status IN ('new', 'proposed') AND NEW.status IN ('new', 'proposed'));
     INSERT INTO app_ingest_changes (item_id, journal_id)
       SELECT NEW.id, OLD.journal_id
       WHERE OLD.journal_id IS NOT NULL AND OLD.journal_id IS NOT NEW.journal_id;
     INSERT INTO app_ingest_changes (item_id, journal_id)
       SELECT NEW.id, NEW.journal_id
       WHERE NEW.journal_id IS NOT NULL AND NEW.journal_id IS NOT OLD.journal_id;
     INSERT INTO app_ingest_changes (item_id, journal_id)
       SELECT NEW.id, OLD.matched_journal_id
       WHERE OLD.matched_journal_id IS NOT NULL AND OLD.matched_journal_id IS NOT NEW.matched_journal_id;
     INSERT INTO app_ingest_changes (item_id, journal_id)
       SELECT NEW.id, NEW.matched_journal_id
       WHERE NEW.matched_journal_id IS NOT NULL AND NEW.matched_journal_id IS NOT OLD.matched_journal_id;
   END;`,
  // 8: how many lines there are in each state, kept by the database itself. The counts a screen shows (how
  // many lines wait, how many are posted, set aside, covered by a payout, held back by the cutover) were
  // each a pass over every line of the Inbox, several times for one reading; they are one row for each
  // account and state, moved by the same statement that moves a line, so no path that changes a line can
  // forget to say so. A line is counted by its source (provider and account), its status, whether a
  // payout covers it and whether the cutover holds it back (excluded for `before_cutover` or `catch_up`).
  // The lines waiting to be proposed for have an index of their own, so finding them is not a pass over
  // the lines waiting.
  `CREATE TABLE app_ingest_tally (
     provider TEXT NOT NULL,
     account_key TEXT NOT NULL,
     status TEXT NOT NULL,
     covered INTEGER NOT NULL,
     held INTEGER NOT NULL,
     n INTEGER NOT NULL,
     PRIMARY KEY (provider, account_key, status, covered, held)
   ) WITHOUT ROWID;
   INSERT INTO app_ingest_tally (provider, account_key, status, covered, held, n)
     SELECT provider, account_key, status, covered_by IS NOT NULL,
       (exclusion_code IS NOT NULL AND exclusion_code IN ('before_cutover', 'catch_up') AND status = 'excluded'), COUNT(*)
     FROM app_ingest_items GROUP BY provider, account_key, status, covered_by IS NOT NULL,
       (exclusion_code IS NOT NULL AND exclusion_code IN ('before_cutover', 'catch_up') AND status = 'excluded');
   CREATE TRIGGER app_ingest_tally_inserted AFTER INSERT ON app_ingest_items
   BEGIN
     INSERT OR IGNORE INTO app_ingest_tally (provider, account_key, status, covered, held, n)
       VALUES (NEW.provider, NEW.account_key, NEW.status, NEW.covered_by IS NOT NULL,
         (NEW.exclusion_code IS NOT NULL AND NEW.exclusion_code IN ('before_cutover', 'catch_up') AND NEW.status = 'excluded'), 0);
     UPDATE app_ingest_tally SET n = n + 1
       WHERE provider = NEW.provider AND account_key = NEW.account_key AND status = NEW.status
         AND covered = (NEW.covered_by IS NOT NULL)
         AND held = ((NEW.exclusion_code IS NOT NULL AND NEW.exclusion_code IN ('before_cutover', 'catch_up') AND NEW.status = 'excluded'));
   END;
   CREATE TRIGGER app_ingest_tally_updated AFTER UPDATE ON app_ingest_items
   WHEN OLD.provider IS NOT NEW.provider OR OLD.account_key IS NOT NEW.account_key
     OR OLD.status IS NOT NEW.status OR (OLD.covered_by IS NULL) IS NOT (NEW.covered_by IS NULL)
     OR OLD.exclusion_code IS NOT NEW.exclusion_code
   BEGIN
     UPDATE app_ingest_tally SET n = n - 1
       WHERE provider = OLD.provider AND account_key = OLD.account_key AND status = OLD.status
         AND covered = (OLD.covered_by IS NOT NULL)
         AND held = ((OLD.exclusion_code IS NOT NULL AND OLD.exclusion_code IN ('before_cutover', 'catch_up') AND OLD.status = 'excluded'));
     INSERT OR IGNORE INTO app_ingest_tally (provider, account_key, status, covered, held, n)
       VALUES (NEW.provider, NEW.account_key, NEW.status, NEW.covered_by IS NOT NULL,
         (NEW.exclusion_code IS NOT NULL AND NEW.exclusion_code IN ('before_cutover', 'catch_up') AND NEW.status = 'excluded'), 0);
     UPDATE app_ingest_tally SET n = n + 1
       WHERE provider = NEW.provider AND account_key = NEW.account_key AND status = NEW.status
         AND covered = (NEW.covered_by IS NOT NULL)
         AND held = ((NEW.exclusion_code IS NOT NULL AND NEW.exclusion_code IN ('before_cutover', 'catch_up') AND NEW.status = 'excluded'));
   END;
   CREATE TRIGGER app_ingest_tally_deleted AFTER DELETE ON app_ingest_items
   BEGIN
     UPDATE app_ingest_tally SET n = n - 1
       WHERE provider = OLD.provider AND account_key = OLD.account_key AND status = OLD.status
         AND covered = (OLD.covered_by IS NOT NULL)
         AND held = ((OLD.exclusion_code IS NOT NULL AND OLD.exclusion_code IN ('before_cutover', 'catch_up') AND OLD.status = 'excluded'));
   END;
   CREATE INDEX app_ingest_items_unproposed ON app_ingest_items (seq)
     WHERE proposed_rev IS NULL AND status IN ('new', 'proposed');`,
  // 9: the days the bank lines are dated on, with how many lines each has, kept the same way. The calendar
  // says a period holds nothing only when no line of the Inbox is dated in it, and asked for every distinct day
  // of every line each time it was read. It is a row for each day, however many lines there are.
  `CREATE TABLE app_ingest_days (day TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
   INSERT INTO app_ingest_days (day, n)
     SELECT posted_on, COUNT(*) FROM app_ingest_items WHERE kind = 'bankLine' GROUP BY posted_on;
   CREATE TRIGGER app_ingest_days_inserted AFTER INSERT ON app_ingest_items
   WHEN NEW.kind = 'bankLine'
   BEGIN
     INSERT OR IGNORE INTO app_ingest_days (day, n) VALUES (NEW.posted_on, 0);
     UPDATE app_ingest_days SET n = n + 1 WHERE day = NEW.posted_on;
   END;
   CREATE TRIGGER app_ingest_days_updated AFTER UPDATE ON app_ingest_items
   WHEN (OLD.kind = 'bankLine' OR NEW.kind = 'bankLine')
     AND (OLD.kind IS NOT NEW.kind OR OLD.posted_on IS NOT NEW.posted_on)
   BEGIN
     UPDATE app_ingest_days SET n = n - 1 WHERE day = OLD.posted_on AND OLD.kind = 'bankLine';
     INSERT OR IGNORE INTO app_ingest_days (day, n) SELECT NEW.posted_on, 0 WHERE NEW.kind = 'bankLine';
     UPDATE app_ingest_days SET n = n + 1 WHERE day = NEW.posted_on AND NEW.kind = 'bankLine';
   END;
   CREATE TRIGGER app_ingest_days_deleted AFTER DELETE ON app_ingest_items
   WHEN OLD.kind = 'bankLine'
   BEGIN
     UPDATE app_ingest_days SET n = n - 1 WHERE day = OLD.posted_on;
   END;`,
  // 10: how many lines each source has for each day, in each state, kept the same way, and an index of the
  // lines that wait (new, proposed or drafted, and not covered by a payout) by day. A list of what waits, with
  // its count and its first page, was a pass over the lines that match the date it was asked for and a sort of
  // them; the count is now a sum over the days (a row for each source, day and state, however many lines a day
  // holds) and the first page is a step into the index, in the order the list is asked for.
  `CREATE TABLE app_ingest_tally_days (
     provider TEXT NOT NULL,
     account_key TEXT NOT NULL,
     day TEXT NOT NULL,
     status TEXT NOT NULL,
     covered INTEGER NOT NULL,
     n INTEGER NOT NULL,
     PRIMARY KEY (provider, account_key, day, status, covered)
   ) WITHOUT ROWID;
   INSERT INTO app_ingest_tally_days (provider, account_key, day, status, covered, n)
     SELECT provider, account_key, posted_on, status, covered_by IS NOT NULL, COUNT(*)
     FROM app_ingest_items GROUP BY provider, account_key, posted_on, status, covered_by IS NOT NULL;
   CREATE TRIGGER app_ingest_tally_days_inserted AFTER INSERT ON app_ingest_items
   BEGIN
     INSERT OR IGNORE INTO app_ingest_tally_days (provider, account_key, day, status, covered, n)
       VALUES (NEW.provider, NEW.account_key, NEW.posted_on, NEW.status, NEW.covered_by IS NOT NULL, 0);
     UPDATE app_ingest_tally_days SET n = n + 1
       WHERE provider = NEW.provider AND account_key = NEW.account_key AND day = NEW.posted_on
         AND status = NEW.status AND covered = (NEW.covered_by IS NOT NULL);
   END;
   CREATE TRIGGER app_ingest_tally_days_updated AFTER UPDATE ON app_ingest_items
   WHEN OLD.provider IS NOT NEW.provider OR OLD.account_key IS NOT NEW.account_key
     OR OLD.posted_on IS NOT NEW.posted_on OR OLD.status IS NOT NEW.status
     OR (OLD.covered_by IS NULL) IS NOT (NEW.covered_by IS NULL)
   BEGIN
     UPDATE app_ingest_tally_days SET n = n - 1
       WHERE provider = OLD.provider AND account_key = OLD.account_key AND day = OLD.posted_on
         AND status = OLD.status AND covered = (OLD.covered_by IS NOT NULL);
     INSERT OR IGNORE INTO app_ingest_tally_days (provider, account_key, day, status, covered, n)
       VALUES (NEW.provider, NEW.account_key, NEW.posted_on, NEW.status, NEW.covered_by IS NOT NULL, 0);
     UPDATE app_ingest_tally_days SET n = n + 1
       WHERE provider = NEW.provider AND account_key = NEW.account_key AND day = NEW.posted_on
         AND status = NEW.status AND covered = (NEW.covered_by IS NOT NULL);
   END;
   CREATE TRIGGER app_ingest_tally_days_deleted AFTER DELETE ON app_ingest_items
   BEGIN
     UPDATE app_ingest_tally_days SET n = n - 1
       WHERE provider = OLD.provider AND account_key = OLD.account_key AND day = OLD.posted_on
         AND status = OLD.status AND covered = (OLD.covered_by IS NOT NULL);
   END;
   CREATE INDEX app_ingest_items_waiting ON app_ingest_items (posted_on)
     WHERE status IN ('new', 'proposed', 'drafted') AND covered_by IS NULL;`,
];

export type ItemStatus = "new" | "proposed" | "drafted" | "posted" | "excluded";
export type ExclusionCode = "manual" | "before_cutover" | "catch_up";

/** What the pipeline keeps per service: its store, its clock, and one proposing run at a time. */
export interface IngestRuntime {
  readonly store: ApplicationStore;
  /** The pipeline's clock, an ISO instant. Replaceable so tests are deterministic. */
  now: () => string;
  /** The proposing run in progress, so concurrent readers wait for one run instead of starting many. */
  refreshing: Promise<unknown> | null;
  /** How long one `inbox.post` call works before it stops and reports what remains. */
  postBudgetMs: number;
  /** The end of the line of postings waiting to prepare and commit: one at a time per book, so
   * that clients of the Inbox do not make each other's plans stale (see `postItems`). */
  postingTurn: Promise<void>;
  /** The last failure the pipeline could not explain to a caller (the ledger did not answer). It
   * is kept for diagnosis and tests and is never sent over the wire. */
  lastUnexpected: unknown;
}

export function ingestRuntime(service: ApplicationService): IngestRuntime {
  return sliceState(service, "ingest", (store) => {
    migrate(store, "ingest", MIGRATIONS);
    return {
      store,
      now: () => service.now(),
      refreshing: null,
      postBudgetMs: 5_000,
      postingTurn: Promise.resolve(),
      lastUnexpected: null,
    } as IngestRuntime;
  });
}

/** A row of `app_ingest_items` joined to its source. `cents` is deliberately never read: it can
 * exceed what a JavaScript number holds exactly, so every amount is read as its text. */
export interface ItemRow {
  seq: number;
  id: string;
  batch_id: string;
  provider: string;
  account_key: string;
  provider_id: string | null;
  fingerprint: string | null;
  occurrence: number | null;
  raw_index: number;
  kind: "bankLine" | "event";
  posted_on: string;
  amount: string;
  currency: string;
  content_key: string;
  text_key: string;
  search: string;
  line: string;
  excerpt: string | null;
  flags: string;
  status: ItemStatus;
  exclusion_code: ExclusionCode | null;
  exclusion_reason: string | null;
  exclusion_at: string | null;
  source_event_id: string;
  ingested_at: string;
  proposed_rev: string | null;
  proposed_head: string | null;
  proposal_problems: string;
  decision: string | null;
  draft_id: string | null;
  draft_version: number | null;
  journal_id: string | null;
  matched_journal_id: string | null;
  pair_item_id: string | null;
  post_operation_id: string | null;
  post_error: string | null;
  /** Set with `post_error` when trying again will not change the failure; see migration 6. */
  post_error_code: string | null;
  covered_by: string | null;
  /** How many times the line has been undone; the ledger source identity of its next posting. */
  source_generation: number;
  ledger_account_id: string | null;
}

/** Every column of an item except `cents` and `search`, plus its source's chart account. */
export const ITEM_COLUMNS = `i.seq, i.id, i.batch_id, i.provider, i.account_key, i.provider_id,
  i.fingerprint, i.occurrence, i.raw_index, i.kind, i.posted_on, i.amount, i.currency, i.content_key,
  i.text_key, i.line, i.excerpt, i.flags, i.status, i.exclusion_code, i.exclusion_reason,
  i.exclusion_at, i.source_event_id, i.ingested_at, i.proposed_rev, i.proposed_head,
  i.proposal_problems, i.decision, i.draft_id, i.draft_version, i.journal_id, i.matched_journal_id,
  i.pair_item_id, i.post_operation_id, i.post_error, i.post_error_code, i.covered_by,
  i.source_generation,
  s.ledger_account_id AS ledger_account_id`;

/** The longest source identity the ledger accepts. */
const MAX_SOURCE_ID = 128;

/** The identity the ledger knows this line's entry under: the line's own `source_event_id` until it
 * has been undone, then that identity with a generation suffix (`-r1`, `-r2`, ...).
 *
 * The ledger refuses a second journal for one source identity, and a reversal does not free it, so
 * a line that went back to review could never be posted again under its first identity. Each undo
 * therefore moves the line to the next generation, which is a new identity the ledger has never
 * seen. Double-booking protection is not weakened: a generation is only created by `inbox.undo`,
 * after the entry of the generation before it has been reversed (or was found already reversed), so
 * at most one entry of a line is ever live; and within one generation the ledger still refuses a
 * second journal. The suffix is deterministic, so a retried posting finds the identity it had.
 *
 * An identity too long for a suffix keeps its front and a digest of the whole, so two long
 * identities that share a front never meet. */
export function ledgerSourceId(
  row: Pick<ItemRow, "source_event_id" | "source_generation">,
): string {
  const generation = row.source_generation ?? 0;
  if (generation === 0) return row.source_event_id;
  const suffix = `-r${generation}`;
  const plain = `${row.source_event_id}${suffix}`;
  if (plain.length <= MAX_SOURCE_ID) return plain;
  const digest = sha256Hex(row.source_event_id).slice(0, 16);
  return `${row.source_event_id.slice(0, MAX_SOURCE_ID - suffix.length - digest.length - 1)}-${digest}${suffix}`;
}

export const ITEM_FROM = `app_ingest_items i LEFT JOIN app_ingest_sources s
  ON s.provider = i.provider AND s.account_key = i.account_key`;

/** The evidence reference a posted journal carries: the batch and row the line came from, and the
 * evidence text the connector supplied for it (the member count and hash of a payout). */
export function evidenceReferenceOf(row: Pick<ItemRow, "batch_id" | "raw_index" | "line">): string {
  const base = `ingest:${row.batch_id}:${row.raw_index}`;
  try {
    const evidence = (JSON.parse(row.line) as { evidence?: unknown }).evidence;
    return typeof evidence === "string" && evidence !== "" ? `${base} ${evidence}` : base;
  } catch {
    return base;
  }
}

/** One item by id, with its source's chart account, or null. */
export function rowById(store: ApplicationStore, id: string): ItemRow | null {
  return store
    .query(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id = ?`)
    .get(id) as ItemRow | null;
}

/** Every day a bank transaction in the Inbox is dated on, whatever became of it (waiting, posted, kept
 * out), each day once and in order. The calendar reads it to say which periods hold nothing. It is read
 * from the days the database keeps (`app_ingest_days`), a row for each day and not a pass over the lines. */
export function inboxLineDates(service: ApplicationService): string[] {
  const rows = ingestRuntime(service)
    .store.query("SELECT day FROM app_ingest_days WHERE n > 0 ORDER BY day")
    .all() as { day: string }[];
  return rows.map((row) => row.day);
}

export const parseFlags = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((flag): flag is string => typeof flag === "string")
      : [];
  } catch {
    return [];
  }
};

/** The in-process view of an item, as proposers and other lanes see it. */
export function toIngestItem(row: ItemRow): IngestItem {
  const flags = parseFlags(row.flags);
  return {
    id: row.id,
    line: JSON.parse(row.line) as IngestLine,
    batchId: row.batch_id,
    status: row.status,
    ledgerAccountId: row.ledger_account_id,
    ...(flags.length > 0 ? { flags } : {}),
    ...(row.covered_by ? { coveredBy: row.covered_by } : {}),
  };
}

/** Record what was done to a line: who, when and why. Events are only ever added. */
export function recordEvent(
  store: ApplicationStore,
  itemId: string,
  at: string,
  kind: string,
  actor: string,
  detail: Readonly<Record<string, string | undefined>> = {},
): void {
  const clean = Object.fromEntries(
    Object.entries(detail).filter(([, value]) => value !== undefined),
  );
  store
    .query(
      "INSERT INTO app_ingest_events (item_id, at, kind, actor, detail) VALUES (?, ?, ?, ?, ?)",
    )
    .run(itemId, at, kind, actor, JSON.stringify(clean));
}

/** SUM of cents as an exact bigint. SQLite sums integers exactly; the text cast keeps the result
 * from being rounded on its way into JavaScript. */
export function sumCents(
  store: ApplicationStore,
  where: string,
  ...bindings: ApplicationBinding[]
): bigint {
  const row = store
    .query(
      `SELECT CAST(COALESCE(SUM(cents), 0) AS TEXT) AS total FROM app_ingest_items i WHERE ${where}`,
    )
    .get(...bindings) as { total: string };
  return BigInt(row.total);
}

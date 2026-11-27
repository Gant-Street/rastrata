/** Product state for the changes lane: who committed each command to the book, and the records of "I
 * have looked at everything up to here".
 *
 * The ledger records one service-level actor on every command, so it cannot say who asked for a
 * change. `commitAction` is where every command is committed, and it is given who is asking; this
 * keeps that, one row for each command, in `changes_commits`. The row is written in the same
 * transaction that marks the command as sent, before the ledger is asked, so a crash cannot lose it;
 * a command the ledger then refuses leaves a row for a command that is not in the book, which nothing
 * reads. The first to ask is the one recorded: a retry of a sent command only reconciles it.
 *
 * `changes_reviews` is append-only, like a reconciliation. A review is a statement by a person that
 * they have looked at the changes up to a point, so it carries two points: the book revision, for the
 * changes the ledger holds, and the instant the list was read, for the changes that live in product
 * state and have no revision. Nothing is edited or deleted. */
import type { AccessPrincipal } from "../../agent/principal.ts";
import { describePrincipal } from "../../agent/principal.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";

export const CHANGES_MIGRATIONS: readonly string[] = [
  // 1: who committed each command, and the reviews.
  `CREATE TABLE changes_commits (
     action_id TEXT PRIMARY KEY,
     principal TEXT NOT NULL,
     label TEXT NOT NULL,
     operation TEXT NOT NULL,
     at TEXT NOT NULL
   );
   CREATE TABLE changes_reviews (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     principal TEXT NOT NULL,
     label TEXT NOT NULL,
     up_to_revision TEXT NOT NULL,
     up_to_at TEXT NOT NULL,
     note TEXT NOT NULL,
     operation_id TEXT NOT NULL UNIQUE
   )`,
];

/** Who is asking for a command to be committed, and through which operation. `by` is what
 * `describePrincipal` makes of the caller ("owner", "agent:<id>", "member:<id>", "service:<name>"). */
export interface Committer {
  readonly by: string;
  readonly operation: string;
}

/** What is kept for a command: who asked for it, under what name, through which operation, and when. */
export interface CommitFacts {
  readonly principal: string;
  readonly label: string;
  readonly operation: string;
  readonly at: string;
}

/** One change to an account's tags, as `accounts.tagHistory` says it. */
export interface TagRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly tag: string;
  readonly effectiveOn: string;
  readonly value: string | null;
  readonly recordedAt: string;
  /** Who made it, as the book records a caller, or null when it was not recorded. */
  readonly by: string | null;
}

export interface ReviewRow {
  readonly seq: number;
  readonly at: string;
  readonly principal: string;
  readonly label: string;
  readonly upToRevision: string;
  readonly upToAt: string;
  readonly note: string;
}

interface CommitRow {
  action_id: string;
  principal: string;
  label: string;
  operation: string;
  at: string;
}

interface DbReviewRow {
  seq: number;
  at: string;
  principal: string;
  label: string;
  up_to_revision: string;
  up_to_at: string;
  note: string;
}

const reviewOf = (row: DbReviewRow): ReviewRow => ({
  seq: row.seq,
  at: row.at,
  principal: row.principal,
  label: row.label,
  upToRevision: row.up_to_revision,
  upToAt: row.up_to_at,
  note: row.note,
});

/** The name a person knows a caller by, taken from the request that was authenticated: an agent's
 * token name, a member's role, the control plane's name. Never an address. */
export function labelOf(principal: AccessPrincipal | undefined): string {
  switch (principal?.kind) {
    case "token":
      return principal.label;
    case "member":
      return principal.role;
    case "service":
      return principal.name;
    default:
      return "owner";
  }
}

/** The most commits a single read returns. A book of 20,000 entries has about that many rows; the
 * limit only stops a runaway table from being read whole into memory. */
const READ_LIMIT = 2_000_000;

/** Who asked for each command, kept as the commits are read: the map by command, and the commands in the order
 * their rows were written. The service only ever adds a row, and the first one for a command stays, so what is
 * held moves on by reading the rows after the last one seen. It is held for the life of the service and not
 * read again from the table; the number of rows is asked for each time it is looked at, and a table that has
 * lost a row (edited by hand, restored from somewhere else) is read again from its first row. */
export class CommitIndex {
  map = new Map<string, CommitFacts>();
  ids: string[] = [];
  /** How many times what is held was thrown away, so that what was made from it can tell. */
  generation = 0;
  #rowid = 0;

  constructor(private readonly store: ApplicationStore) {}

  /** Read the rows written since the last look. */
  refresh(): this {
    // The rows there were before the last look must still be the rows there are: the table has as many as
    // were read and the ones written since.
    const held = this.store
      .query("SELECT COUNT(*) AS total, COALESCE(SUM(rowid > ?), 0) AS fresh FROM changes_commits")
      .get(this.#rowid) as { total: number; fresh: number };
    if (held.total - held.fresh !== this.ids.length) {
      this.map = new Map();
      this.ids = [];
      this.#rowid = 0;
      this.generation += 1;
    }
    const rows = this.store
      .query(
        "SELECT rowid, action_id, principal, label, operation, at FROM changes_commits WHERE rowid > ? ORDER BY rowid",
      )
      .all(this.#rowid) as (CommitRow & { rowid: number })[];
    for (const row of rows) {
      this.#rowid = row.rowid;
      if (this.map.has(row.action_id)) continue;
      this.map.set(row.action_id, {
        principal: row.principal,
        label: row.label,
        operation: row.operation,
        at: row.at,
      });
      this.ids.push(row.action_id);
    }
    return this;
  }
}

export class ChangesState {
  /** Names of callers seen in this process, by what `describePrincipal` says, so a commit made deep
   * in the service can be recorded under the caller's name without every layer passing it down. */
  private readonly names = new Map<string, string>();

  /** What the account-tags source last read, for as long as neither the tags nor the chart has
   * changed: reading the history takes a call for each account. */
  tagCache: { readonly key: string; readonly rows: readonly TagRow[] } | null = null;

  constructor(private readonly store: ApplicationStore) {
    migrate(store, "changes", CHANGES_MIGRATIONS);
  }

  /** Remember what an authenticated caller is called. Called once for each request. */
  rememberCaller(principal: AccessPrincipal | undefined): void {
    if (principal === undefined || principal.kind === "owner") return;
    this.names.set(describePrincipal(principal), labelOf(principal));
  }

  /** The name a caller is recorded under: the one seen on a request, else what the string itself
   * says (an agent is its identifier), so a commit made by code that never saw a request still
   * names who asked. */
  labelFor(principal: string): string {
    const known = this.names.get(principal);
    if (known !== undefined) return known;
    if (principal === "owner") return "owner";
    const at = principal.indexOf(":");
    if (at < 0) return principal;
    const kind = principal.slice(0, at);
    const id = principal.slice(at + 1);
    return kind === "agent" ? `agent ${id.slice(0, 8)}` : kind === "member" ? "member" : id;
  }

  /** Keep who asked for this command. Call it inside the transaction that marks the command as sent.
   * The first to ask is kept; asking again changes nothing. */
  recordCommit(actionId: string, committer: Committer, at: string): void {
    this.store
      .query(
        "INSERT OR IGNORE INTO changes_commits (action_id, principal, label, operation, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(actionId, committer.by, this.labelFor(committer.by), committer.operation, at);
  }

  #commitIndex: CommitIndex | null = null;

  /** Who asked for each command, brought up to the rows written so far. */
  commitIndex(): CommitIndex {
    this.#commitIndex ??= new CommitIndex(this.store);
    return this.#commitIndex.refresh();
  }

  /** Every recorded commit, by the id of the command. */
  commits(): Map<string, CommitFacts> {
    const rows = this.store
      .query(
        "SELECT action_id, principal, label, operation, at FROM changes_commits ORDER BY rowid LIMIT ?",
      )
      .all(READ_LIMIT) as CommitRow[];
    const found = new Map<string, CommitFacts>();
    for (const row of rows)
      found.set(row.action_id, {
        principal: row.principal,
        label: row.label,
        operation: row.operation,
        at: row.at,
      });
    return found;
  }

  /** Record that someone has looked at the changes up to a point. */
  addReview(input: {
    readonly at: string;
    readonly principal: string;
    readonly label: string;
    readonly upToRevision: string;
    readonly upToAt: string;
    readonly note: string;
    readonly operationId: string;
  }): ReviewRow {
    this.store
      .query(
        "INSERT INTO changes_reviews (at, principal, label, up_to_revision, up_to_at, note, operation_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.at,
        input.principal,
        input.label,
        input.upToRevision,
        input.upToAt,
        input.note,
        input.operationId,
      );
    const row = this.store
      .query(
        "SELECT seq, at, principal, label, up_to_revision, up_to_at, note FROM changes_reviews WHERE operation_id=?",
      )
      .get(input.operationId) as DbReviewRow;
    return reviewOf(row);
  }

  /** The newest review, whoever made it, or null if none was ever made. */
  newestReview(): ReviewRow | null {
    const row = this.store
      .query(
        "SELECT seq, at, principal, label, up_to_revision, up_to_at, note FROM changes_reviews ORDER BY seq DESC LIMIT 1",
      )
      .get() as DbReviewRow | null;
    return row ? reviewOf(row) : null;
  }

  /** Every review, newest first, up to `limit`. */
  reviews(limit = 100): ReviewRow[] {
    return (
      this.store
        .query(
          "SELECT seq, at, principal, label, up_to_revision, up_to_at, note FROM changes_reviews ORDER BY seq DESC LIMIT ?",
        )
        .all(limit) as DbReviewRow[]
    ).map(reviewOf);
  }
}

export const changesState = (service: ApplicationService): ChangesState =>
  sliceState(service, "changes", (store) => new ChangesState(store));

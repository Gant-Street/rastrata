/** Product state of the entries slice: the display settings, and the plan of a change of account.
 *
 * Both are kept in one migrated list under the slice's name, so a host that keeps a log of the book
 * makes the tables at one known moment (see `prepareSlices`). A released step is never edited. */
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";

export const ENTRIES_MIGRATIONS: readonly string[] = [
  // 1: the display settings, one row each, and the record of who changed what.
  `CREATE TABLE app_book_settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) WITHOUT ROWID;
   CREATE TABLE app_book_changes (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     actor TEXT NOT NULL,
     setting TEXT NOT NULL,
     before TEXT,
     after TEXT NOT NULL
   );`,
  // 2: the transactions a change of account has taken in hand. One row is written before the first
  // step of a transaction (its old entry is reversed), so that a request that was killed halfway and is
  // sent again under the same identity knows which transactions it had begun, and from where. The row
  // says what was intended; where a transaction has got to is read from the books and the Inbox, never
  // kept here, so the two cannot disagree. Nothing is updated or deleted.
  `CREATE TABLE entries_moves (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     operation_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     journal_id TEXT NOT NULL,
     from_account_id TEXT NOT NULL,
     to_account_id TEXT NOT NULL,
     generation INTEGER NOT NULL,
     planned_at TEXT NOT NULL,
     UNIQUE (operation_id, item_id)
   );
   CREATE INDEX entries_moves_item ON entries_moves (item_id);`,
];

/** The slice's store, with its tables made. */
export function entriesStore(service: ApplicationService): ApplicationStore {
  return sliceState(service, "entries", (store) => {
    migrate(store, "entries", ENTRIES_MIGRATIONS);
    return store;
  });
}

/** One transaction a change of account has taken in hand. */
export interface MovePlan {
  readonly operationId: string;
  readonly itemId: string;
  /** The entry that was on the old account, and is being replaced. */
  readonly journalId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  /** How many times the transaction had been taken back when the move began (its `source_generation`);
   * a transaction that has been taken back once since is the one this move returned to review. */
  readonly generation: number;
}

interface MoveRow {
  operation_id: string;
  item_id: string;
  journal_id: string;
  from_account_id: string;
  to_account_id: string;
  generation: number;
}

/** The transactions this request had begun, in the order it began them. */
export function plannedMoves(store: ApplicationStore, operationId: string): MovePlan[] {
  return (
    store
      .query(
        "SELECT operation_id, item_id, journal_id, from_account_id, to_account_id, generation FROM entries_moves WHERE operation_id=? ORDER BY seq",
      )
      .all(operationId) as MoveRow[]
  ).map((row) => ({
    operationId: row.operation_id,
    itemId: row.item_id,
    journalId: row.journal_id,
    fromAccountId: row.from_account_id,
    toAccountId: row.to_account_id,
    generation: row.generation,
  }));
}

/** Take a transaction in hand. Asking again for one already taken changes nothing. */
export function planMove(store: ApplicationStore, plan: MovePlan, at: string): void {
  store
    .query(
      "INSERT OR IGNORE INTO entries_moves (operation_id, item_id, journal_id, from_account_id, to_account_id, generation, planned_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      plan.operationId,
      plan.itemId,
      plan.journalId,
      plan.fromAccountId,
      plan.toAccountId,
      plan.generation,
      at,
    );
}

import { Database } from "bun:sqlite";
import type { LocalBookService } from "@rastrata/application/local";
import {
  commitmentOf,
  fromStartSeconds,
  replayGrowthOf,
  restartSeconds,
  type BookCommitment,
  type ReplayGrowth,
} from "@rastrata/application/replay-cost";

/** The most a saved snapshot of one book can be: the kernel refuses to encode a book of more than
 * 16 MiB (`MAX_DURABLE_BYTES` in packages/kernel/src/codec.ts, which is not exported), about 1,600
 * journals of two lines (10 KB a journal, measured). It is the limit of the snapshot, not of the book.
 * Past it the service keeps working from the state it has verified in memory and cannot save a newer
 * snapshot, so a restart reads the last one it saved and replays the entries made since, or the whole
 * book when there is none. How much that costs depends on the kind of book (`commitment`): about a
 * millisecond an entry for a book made with the chain-head state commitment, and a cost that grows with
 * the square of the book for one made without it. See "The scale limit" in
 * docs/reference/program/main.md. */
export const SNAPSHOT_CEILING_BYTES = 16 * 1024 * 1024;

/** How much one book holds, for `rastrata doctor` (GET /api/capacity, owner only). Only counts and
 * sizes: nothing of the book itself. */
export interface BookCapacity {
  /** False until the book has been set up; the rest is then zero or null. */
  readonly configured: boolean;
  /** The journals the book holds now. */
  readonly journals: number;
  /** The entries in the ledger (the head's sequence): a restart replays those after the snapshot. */
  readonly outcomes: number;
  /** The most a saved snapshot can be (16 MiB), not a limit of the book: see `commitment`. */
  readonly ceilingBytes: number;
  /** The snapshot saved in the book's file, if there is one: its size in bytes and the entry it was
   * saved at. The service saves one every 100 entries and when it stops, until the book is too big
   * to encode; the last one saved stays. */
  readonly snapshot: { readonly bytes: number; readonly sequence: number } | null;
  /** Which kind of book this is, from the marker in its configuration snapshot: `chain-head` for a
   * book made with the chain-head state commitment (every book the application makes now), `legacy`
   * for one made without it (the install package built on 2026-10-06, and older test books). Null
   * until the book is set up. Added 2026-10-07; an older service does not say. */
  readonly commitment: BookCommitment | null;
  /** How reading the book from its first entry grows with its size: `linear` for a chain-head book,
   * `quadratic` for a legacy one. Null until the book is set up. */
  readonly replay: ReplayGrowth | null;
  /** About how many seconds reading the whole book from its first entry takes, by the rule of thumb
   * for its kind (packages/application/src/replay-cost.ts). Null until the book is set up. */
  readonly fromStartSeconds: number | null;
  /** About how many seconds a restart takes now: the saved snapshot read and the entries since it
   * replayed, or everything replayed when there is no snapshot. The same rule of thumb. Null until the
   * book is set up. `rastrata doctor` prefers the replay its newest verified backup timed. */
  readonly restartSeconds: number | null;
}

/** What the file's saved snapshot is, read through a second, read-only connection so that the
 * service's own is not disturbed. Null when there is none, or when the file cannot be read. */
export function savedSnapshot(path: string): BookCapacity["snapshot"] {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const row = db
      .query(
        "SELECT sequence, length(CAST(encoded AS BLOB)) AS bytes FROM app_read_snapshots WHERE id = 1",
      )
      .get() as { sequence: string; bytes: number } | null;
    if (!row) return null;
    const sequence = Number(row.sequence);
    return Number.isSafeInteger(sequence) && row.bytes > 0 ? { bytes: row.bytes, sequence } : null;
  } catch {
    // No table yet (no snapshot has ever been saved), or a file that cannot be opened read-only.
    return null;
  } finally {
    db?.close();
  }
}

/** Tenths of a second are all an estimate of this kind can claim. */
const tenths = (seconds: number): number => Math.round(seconds * 10) / 10;

export async function bookCapacity(
  service: LocalBookService,
  databasePath: string,
): Promise<BookCapacity> {
  if (!service.setupState())
    return {
      configured: false,
      journals: 0,
      outcomes: 0,
      ceilingBytes: SNAPSHOT_CEILING_BYTES,
      snapshot: null,
      commitment: null,
      replay: null,
      fromStartSeconds: null,
      restartSeconds: null,
    };
  const { aggregate, head } = await service.readAggregate();
  const state = aggregate.state;
  // The journals are counted by the posting sequence, which equals their number in every valid state
  // (the kernel checks it at load and at admission), not by reading `state.journals`: on a state the
  // kernel built that copies and freezes the whole list, once per state.
  const journals = Number(state.latestPostingSequence);
  const outcomes = Number(head.sequence);
  const snapshot = savedSnapshot(databasePath);
  const commitment = commitmentOf(state);
  const growth = replayGrowthOf(commitment);
  const size = { journals, entries: outcomes };
  return {
    configured: true,
    journals,
    outcomes,
    ceilingBytes: SNAPSHOT_CEILING_BYTES,
    snapshot,
    commitment,
    replay: growth,
    fromStartSeconds: tenths(fromStartSeconds(growth, size)),
    restartSeconds: tenths(restartSeconds(growth, size, snapshot)),
  };
}

/** What it costs to read a book back, in seconds, for every place that tells a person how long it will
 * take or how big a book can get: the warm-up's "Reading your books, about N seconds", the progress of a
 * backup check and of a restore, and `GET /api/capacity` (which `rastrata doctor` reads). Pure and
 * portable: no file system, no clock.
 *
 * There are two kinds of book, and they read back at different speeds. A **chain-head** book was made
 * with `chain-head-state-commitment-v1`: its state hash names the head of its revision chain, so the
 * independent second evaluation that a replay re-runs for every ledger entry costs the same at 20,000
 * journals as at 20, and a replay is linear in the entries. Every book `ApplicationService.setup` makes
 * has it. A **legacy** book was made without it (the install package built on 2026-10-06, and older test
 * books): its state hash re-encodes every journal on every command, so a replay costs about the square
 * of the book. There is no migration; a legacy book stays legacy. See docs/reference/program/scale/
 * scaleestimates.md for what was measured and docs/reference/program/main.md, "The scale limit".
 *
 * Every constant below says where it came from. They are rules of thumb for a laptop of the kind the
 * measurements were made on; the places that can time the real thing (the warm-up reading pages, a
 * verified backup that timed its replay) prefer their own measurement and use these only until they
 * have one. */
import { CHAIN_HEAD_STATE_COMMITMENT_PROFILE, decodeDurableBook } from "@rastrata/kernel";

/** Which kind of book it is, by the marker its configuration snapshot carries. */
export type BookCommitment = "chain-head" | "legacy";

/** How reading a book from its first entry grows with the book. */
export type ReplayGrowth = "linear" | "quadratic";

/** The kind of a book from its state. Reads one property of the active configuration snapshot: never
 * `state.journals`, whose first read on a state the kernel built copies and freezes the whole list. */
export function commitmentOf(state: {
  readonly activeConfigurationSnapshot: { readonly stateCommitmentProfile?: string | undefined };
}): BookCommitment {
  return state.activeConfigurationSnapshot.stateCommitmentProfile ===
    CHAIN_HEAD_STATE_COMMITMENT_PROFILE
    ? "chain-head"
    : "legacy";
}

/** The kind of a book from its starting record (the genesis the ledger keeps), or null when that cannot
 * be decoded. A genesis has no journals, so decoding it takes a few milliseconds whatever the book's
 * size. */
export function commitmentOfGenesis(encoded: string): BookCommitment | null {
  const decoded = decodeDurableBook(encoded);
  return decoded.disposition === "decoded" ? commitmentOf(decoded.aggregate.state) : null;
}

/** How a kind of book grows. A book whose kind is not known is treated as the slow kind: telling a
 * person to expect more time than it takes is the safer mistake. */
export function replayGrowthOf(commitment: BookCommitment | null | undefined): ReplayGrowth {
  return commitment === "chain-head" ? "linear" : "quadratic";
}

/** Seconds to re-execute one ledger entry of a chain-head book, whatever the size of the book. Measured
 * with `N=... REPLAY=yes bun bench/scale.ts` in packages/application on a quiet Apple-silicon laptop
 * (Bun 1.4.2, 2026-10-07), the cost of a restart per entry: 0.80 ms at 500 journals, 0.74 at 2,000,
 * 0.78 at 5,000, 0.72 at 20,000 (replay) and 0.73 to 0.88 for a cold restart in a fresh process at
 * 5,000 and 20,000 (which opens the database, and tries and fails to save a snapshot); 0.79 for a
 * chart of 100 accounts with ten configuration revisions at 5,000. Rounded up to a millisecond: the
 * computers people own are slower than a quiet development laptop, and a real book also has closes and
 * configuration changes, which cost more than a posting. */
export const CHAIN_HEAD_SECONDS_PER_ENTRY = 0.001;

/** Seconds to read a legacy book of a thousand journals and a thousand entries from its first entry.
 * The integrator's measurement (22 s; 21.6 s at 1,000 journals measured by the `scaleindex` lane on the
 * landed kernel; about 90 s at 2,000). Each entry costs in proportion to the journals the book holds when
 * it is applied, so the whole grows with journals times entries. */
export const LEGACY_SECONDS_AT_A_THOUSAND = 22;

/** The fewest seconds a start takes: the process, the database, the first page. */
export const START_FLOOR_SECONDS = 1;

/** What reading a saved snapshot costs, for either kind of book (decoding it and checking every
 * revision, command and effect in it is linear): a fixed part and a part per MiB. Measured at 1,500
 * journals, a 14.6 MiB snapshot, in a fresh process: 0.35 s (0.23 ms a journal); a 5 MiB one in 0.1 s.
 * Rounded up. */
export const SNAPSHOT_LOAD_FIXED_SECONDS = 0.1;
export const SNAPSHOT_LOAD_SECONDS_PER_MIB = 0.025;

/** A restart this long, in seconds, is worth saying so about, whatever else is true. */
export const SLOW_RESTART_SECONDS = 60;

/** How big a book is, for the estimates: the journals it holds, and the entries of its ledger (every
 * command that was run, including the activation, configuration changes, closes and rejected commands),
 * which is what a replay applies. */
export interface BookSize {
  readonly journals: number;
  readonly entries: number;
}

/** The snapshot saved in the book's file: its size and the ledger entry it was saved at. */
export interface SavedSnapshotSize {
  readonly bytes: number;
  readonly sequence: number;
}

function entriesOf(size: BookSize): number {
  return Math.max(size.entries, size.journals, 1);
}

/** About how long reading the whole book from its first entry takes, by the rule of thumb. */
export function fromStartSeconds(growth: ReplayGrowth, size: BookSize): number {
  const entries = entriesOf(size);
  const seconds =
    growth === "linear"
      ? entries * CHAIN_HEAD_SECONDS_PER_ENTRY
      : LEGACY_SECONDS_AT_A_THOUSAND * (size.journals / 1000) * (entries / 1000);
  return Math.max(START_FLOOR_SECONDS, seconds);
}

/** About how long reading a saved snapshot takes. */
export function snapshotLoadSeconds(bytes: number): number {
  return SNAPSHOT_LOAD_FIXED_SECONDS + (SNAPSHOT_LOAD_SECONDS_PER_MIB * bytes) / (1 << 20);
}

/** About how long a restart takes: it reads the saved snapshot and replays the entries made since, or
 * replays everything when there is none, and never takes longer than reading from the start. An entry
 * of a linear replay costs the same whatever the size of the book; an entry of a quadratic one, at the
 * size the book has now, costs twice the average over the replay that built it. */
export function restartSeconds(
  growth: ReplayGrowth,
  size: BookSize,
  snapshot: SavedSnapshotSize | null,
): number {
  const fromStart = fromStartSeconds(growth, size);
  if (snapshot === null) return fromStart;
  const entries = entriesOf(size);
  const since = Math.max(0, entries - snapshot.sequence);
  const perEntry = growth === "linear" ? CHAIN_HEAD_SECONDS_PER_ENTRY : (2 * fromStart) / entries;
  return Math.min(fromStart, snapshotLoadSeconds(snapshot.bytes) + since * perEntry);
}

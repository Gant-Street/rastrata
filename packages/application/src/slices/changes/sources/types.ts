/** What a source of changes is, besides the ledger. A source reads what another part of Rastrata
 * keeps, only through that part's own operations, with the caller's own permissions: a source the
 * caller may not read is named as one that could not be read, with the reason, and never left out
 * quietly. */
import type { Candidate } from "../../../changes/candidate.ts";
import type { SourceName } from "../../../changes/kinds.ts";
import type { SliceContext } from "../../types.ts";

/** The part of the window that sources without a revision work to: changes after (or from) `sinceAt`
 * and up to `untilAt`, as ISO instants. */
export interface SourceWindow {
  /** Null: from the start. */
  readonly sinceAt: string | null;
  /** Whether a change at exactly `sinceAt` is inside (a window that starts on a date) or already
   * seen (a window that starts after a point). */
  readonly sinceInclusive: boolean;
  readonly untilAt: string;
}

export interface SourceInput {
  readonly context: SliceContext;
  readonly window: SourceWindow;
}

/** What a source found. `incomplete` says, in words, what it could not read when it read only part of
 * what it keeps; the list then names the source as not read in full. */
export interface SourceResult {
  readonly candidates: readonly Candidate[];
  readonly incomplete?: string;
  /** What this sign-in may not read of the source, in one sentence: left out, not a failure. The list is
   * still not all there is, so they cannot mark it as looked at. */
  readonly withheld?: string;
}

export interface SourceReader {
  readonly name: Exclude<SourceName, "ledger" | "review">;
  /** In plain words, for the list that says which sources were read. */
  readonly title: string;
  /** Every change this source knows of at or before `window.untilAt`; the caller applies the rest of
   * the window. Throws when it cannot be read at all: an `ApplicationError` for a reason a person can
   * act on. */
  read(input: SourceInput): Promise<SourceResult>;
}

/** Is `at` inside the window? */
export function inWindow(at: string, window: SourceWindow): boolean {
  if (at > window.untilAt) return false;
  if (window.sinceAt === null) return true;
  return window.sinceInclusive ? at >= window.sinceAt : at > window.sinceAt;
}

/** An instant as the service writes one, or null for text that is not an instant. */
export function asInstant(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** The fiscal periods that hold at least one entry of the book, kept current from the ledger's own new
 * revisions instead of read from every entry each time the calendar is.
 *
 * The calendar calls a period empty when no entry is dated in it and nothing waits for it in the Inbox. The
 * entries of a book are never taken out (a reversal or a correction adds entries), so the set of periods
 * that hold one only grows, and a state one revision on has the periods of the state before it and those of
 * the entries that revision added.
 *
 * One set is kept for each book and moved on in place, as `slices/ingest/match-index.ts` does: asked for the
 * state that follows the one it stands at (the next revisions of the same hash chain) it takes in the
 * entries those revisions added, and asked for anything else it is made from the state. It is held to the
 * whole read by `test/period-entries.test.ts` at every state of random books. */
import type { BookState } from "@rastrata/kernel";
import { deltaOf, positionOf, revisionsAfter, type Position } from "../reports/ledger-history.ts";

class Held {
  readonly ids = new Set<string>();
  position: Position;

  constructor(position: Position) {
    this.position = position;
  }
}

const kept = new WeakMap<object, Held>();

/** The identifiers of the fiscal periods with an entry in them, at exactly this state. The set is the one kept
 * for the book and is moved on at the next state: read it where it is asked for, and do not keep it. */
export function periodsWithEntries(state: BookState): ReadonlySet<string> {
  const held = kept.get(state.identity);
  if (held) {
    const revisions = revisionsAfter(state, held.position);
    if (revisions !== null) {
      if (revisions.length > 0) {
        for (const booked of deltaOf(revisions).journals)
          held.ids.add(String(booked.fiscalPeriodId));
        held.position = positionOf(state);
      }
      return held.ids;
    }
  }
  const built = new Held(positionOf(state));
  for (const booked of state.journals) built.ids.add(String(booked.fiscalPeriodId));
  // A state older than the one kept (a read pinned to an earlier revision) is answered and not remembered.
  if (!held || built.position.revision >= held.position.revision) kept.set(state.identity, built);
  return built.ids;
}

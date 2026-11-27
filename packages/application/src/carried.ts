import type { BookState } from "@rastrata/kernel";

import {
  deltaOf,
  positionOf,
  revisionsAfter,
  type Delta,
  type Position,
} from "./reports/ledger-history.ts";

/** Something derived from a book state, such as a list of the postings of every bank account, that is
 * worked out for each new state. A state is almost always the state before it plus one command, so the
 * thing for the new state is the thing for the old one with that command's journals, corrections and
 * configuration changes put in: a posting costs the posting and not the book. Declare how to make the
 * thing from nothing and how to carry it forward, and `carriedBy` does the rest: it finds the thing for
 * an earlier state of the same book, checks by the book's hash chain that the new state is that history
 * carried on, and makes the thing from nothing whenever it cannot (or when `extend` says it cannot). */
export interface Carried<T> {
  /** The thing for this state, worked out from the whole book. */
  build(state: BookState): T;
  /** The thing for `state`, from the thing for an earlier state of the book and what happened between.
   * Null when it is simpler to build it again (a kind of change that is rare and awkward to carry). It
   * must give exactly what `build` would. */
  extend(previous: T, delta: Delta, state: BookState): T | null;
}

interface Entry<T> {
  readonly position: Position;
  /** What the state's posting sequence and corrections stood at, to tell that the delta is all there is. */
  readonly sequence: bigint;
  readonly corrections: number;
  readonly value: T;
}

/** A function from a book state to the thing, made once per state and carried from the state before when
 * that is possible. The two newest are kept for each book (a state that branches off does not cost the
 * next real state its predecessor), found through the object every state of one book shares; a book
 * whose states are all gone takes its entries with it. */
export function carriedBy<T extends object>(carried: Carried<T>): (state: BookState) => T {
  const known = new WeakMap<BookState, T>();
  const lineages = new WeakMap<object, Entry<T>[]>();
  return (state) => {
    const hit = known.get(state);
    if (hit !== undefined) return hit;
    const peers = lineages.get(state.identity) ?? [];
    let value: T | null = null;
    for (let index = peers.length - 1; index >= 0 && value === null; index -= 1) {
      const peer = peers[index] as Entry<T>;
      const revisions = revisionsAfter(state, peer.position);
      if (revisions === null) continue;
      const delta = deltaOf(revisions);
      if (
        peer.sequence + BigInt(delta.journals.length) !== state.latestPostingSequence ||
        peer.corrections + delta.links.length !== state.corrections.length
      )
        continue;
      value = revisions.length === 0 ? peer.value : carried.extend(peer.value, delta, state);
    }
    value ??= carried.build(state);
    known.set(state, value);
    const position = positionOf(state);
    const newest = [
      ...peers,
      {
        position,
        sequence: state.latestPostingSequence,
        corrections: state.corrections.length,
        value,
      },
    ].sort((left, right) =>
      left.position.revision < right.position.revision
        ? -1
        : left.position.revision > right.position.revision
          ? 1
          : 0,
    );
    lineages.set(state.identity, newest.slice(-2));
    return value;
  };
}

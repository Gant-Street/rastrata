/** A change found cheaply, whose whole record is made only if it is shown. Every source gives these:
 * the ledger one for each revision, the others one for each thing they keep a time for. Pure and
 * portable. */
import type { ChangeRecord } from "../client-contracts.gen.ts";
import type { ActorRef, ChangeKind } from "./kinds.ts";

export interface Candidate {
  /** An ISO instant in UTC with milliseconds, so two can be compared as text. */
  readonly at: string;
  /** The book revision it made, or null for a change that is not in the ledger. */
  readonly revision: bigint | null;
  readonly kind: ChangeKind;
  readonly actor: ActorRef;
  /** Text that puts two changes made at the same instant in a fixed order. */
  readonly order: string;
  readonly build: () => ChangeRecord;
}

/** Newest first: later `at` before earlier, then the change the ledger holds before one that it does
 * not, then by `order`. A source whose own order is not by `at` (the ledger's is by revision) is
 * merged with `mergeNewestFirst`, which keeps each source's order. */
export function newestFirst(left: Candidate, right: Candidate): number {
  if (left.at !== right.at) return left.at < right.at ? 1 : -1;
  const l = left.revision ?? -1n;
  const r = right.revision ?? -1n;
  if (l !== r) return l < r ? 1 : -1;
  return left.order < right.order ? -1 : left.order > right.order ? 1 : 0;
}

/** The first `limit` of several lists merged newest first. Each list keeps its own order; at each step
 * the list whose next change is newest gives it. This keeps the ledger's changes in the order the
 * book made them even where a time was recorded out of step, and costs what is taken, not what is held. */
export function mergeNewestFirst<T extends Candidate>(
  lists: readonly (readonly T[])[],
  limit: number,
): T[] {
  const at = lists.map(() => 0);
  const out: T[] = [];
  while (out.length < limit) {
    let best = -1;
    for (let index = 0; index < lists.length; index += 1) {
      const head = lists[index]?.[at[index] as number];
      if (head === undefined) continue;
      if (best < 0 || newestFirst(head, lists[best]?.[at[best] as number] as T) < 0) best = index;
    }
    if (best < 0) break;
    out.push(lists[best]?.[at[best] as number] as T);
    at[best] = (at[best] as number) + 1;
  }
  return out;
}

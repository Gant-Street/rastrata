/** Configuration snapshots the kernel has itself verified and owns. A snapshot's content hash is
 * recomputed over the whole chart and every policy, which costs more than everything else a command
 * does for a book with a realistic chart, and it is paid for every retained snapshot on every
 * admission. A snapshot the kernel built, or decoded, hash-checked and froze, cannot change, so
 * recomputing its hash again can only give the same answer.
 *
 * Membership is granted only by the kernel, at the three places that create or accept a snapshot:
 * createBookState (it computed the hash over the parts it froze), applyEffects (it recomputes the
 * hash of the committed snapshot first) and decodeDurableBook (validateBookState rehashed it and the
 * whole aggregate is then deep-frozen). Marking freezes everything reachable from the snapshot, so
 * the memory is sound by construction and does not depend on how a caller built the parts; the
 * kernel's own construction already freezes them, and tests count `froze` to prove it. It names an
 * object, never a hash: a copy, a spread or a snapshot a caller built is a different object and is
 * checked in full. This module is internal and is not exported from the package entry point, so a
 * caller cannot grant membership. */
const verified = new WeakSet<object>();
let reused = 0;
let rehashed = 0;
let froze = 0;

function freezeDeep(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const member of Object.values(value)) freezeDeep(member, seen);
  if (!Object.isFrozen(value)) froze += 1;
  Object.freeze(value);
}

/** Freeze everything reachable from `snapshot` and remember that the kernel verified exactly this
 * object. Call it only after the snapshot's hash has been recomputed and found equal. */
export function markVerifiedSnapshot(snapshot: object): void {
  freezeDeep(snapshot, new WeakSet());
  verified.add(snapshot);
}

/** True when the kernel has already verified exactly this immutable object; otherwise the answer of
 * `rehash`, the full recomputation. */
export function verifiedOr(snapshot: object, rehash: () => boolean): boolean {
  if (verified.has(snapshot)) {
    reused += 1;
    return true;
  }
  rehashed += 1;
  return rehash();
}

/** For tests: how many snapshot checks reused a verification, how many recomputed the hash, and how
 * many objects marking itself had to freeze (zero when the caller already froze them). */
export function snapshotVerifications(): { readonly reused: number; readonly rehashed: number; readonly froze: number } {
  return { reused, rehashed, froze };
}

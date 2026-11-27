/** For tests in other packages that need to say "this path copies no list of the book": the kernel's
 * count of the journal, revision and retained-result lists it has copied and frozen on demand. Reading
 * `state.journals`, `state.revisions` or `protocol.retainedResults` of a state the kernel built copies the
 * whole list once, so a path that must stay O(1) in the size of the book asserts the count does not move
 * (see "Which reads force the copy" in docs/reference/program/scale/scaleindex.md). */
export { bookHistoryMaterializations } from "@rastrata/kernel";
